/**
 * StrReplaceEditor Tool — File viewing, creation, and editing.
 *
 * Translated from: app/tool/str_replace_editor.py (433 lines)
 *                  app/tool/file_operators.py (LocalFileOperator)
 *
 * Key behaviors preserved:
 * 1. 5 commands: view, create, str_replace, insert, undo_edit
 * 2. str_replace requires old_str appears EXACTLY once (0 or >1 → error with details)
 * 3. create refuses to overwrite existing files
 * 4. _file_history stack per path for undo support
 * 5. Output truncated at 16000 chars
 * 6. view shows line numbers (cat -n format)
 * 7. view on directory: lists files up to 2 levels deep
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { EDITOR } from "../config/constants.js";
import { getOperator, checkPathBoundary, type FileOperator } from "./fileOperators.js";

const SNIPPET_LINES = EDITOR.SNIPPET_LINES;
const MAX_RESPONSE_LEN = EDITOR.MAX_RESPONSE_LEN;
const TRUNCATED_MESSAGE = EDITOR.TRUNCATED_MESSAGE;

interface EditHistoryEntry {
  kind: "create" | "edit";
  previousContent?: string;
}

// File history for undo support — Map<path, history[]>
const fileHistory: Map<string, EditHistoryEntry[]> = new Map();

/** Truncate content if it exceeds max length. */
function maybeTruncate(content: string, maxLen = MAX_RESPONSE_LEN): string {
  if (content.length <= maxLen) return content;
  return content.slice(0, maxLen) + TRUNCATED_MESSAGE;
}

/** Format file content with line numbers (cat -n style). */
function formatWithLineNumbers(
  content: string,
  descriptor: string,
  initLine = 1
): string {
  const truncated = maybeTruncate(content);
  const expandedTabs = truncated.replace(/\t/g, "        ");
  const numbered = expandedTabs
    .split("\n")
    .map((line, i) => `${String(i + initLine).padStart(6)}\t${line}`)
    .join("\n");
  return `Here's the result of running \`cat -n\` on ${descriptor}:\n${numbered}\n`;
}

/** Get the current file operator (local or sandbox). */
function op(): FileOperator {
  return getOperator();
}

// ---- Command implementations ----

async function viewCommand(
  path: string,
  viewRange?: number[]
): Promise<string> {
  const o = op();
  if (await o.isDirectory(path)) {
    if (viewRange) {
      return "Error: The `view_range` parameter is not allowed when `path` points to a directory.";
    }
    try {
      // S-5: 走 FileOperator.listDirectory（local 用 fs.readdir，sandbox 用 shellQuote 的 find）
      const entries = await o.listDirectory(path, 2);
      return `Here's the files and directories up to 2 levels deep in ${path}, excluding hidden items:\n${entries.join("\n")}`;
    } catch (e: any) {
      return `Error listing directory: ${e.message}`;
    }
  }

  // File view
  let content = await o.readFile(path);
  let initLine = 1;

  if (viewRange) {
    if (viewRange.length !== 2) {
      return "Error: Invalid `view_range`. It should be a list of two integers.";
    }
    const lines = content.split("\n");
    const nLines = lines.length;
    const [start, end] = viewRange;

    if (start < 1 || start > nLines) {
      return `Error: Invalid \`view_range\`: [${start}, ${end}]. First element should be within [1, ${nLines}]`;
    }
    if (end !== -1 && end > nLines) {
      return `Error: Invalid \`view_range\`: [${start}, ${end}]. Second element should be <= ${nLines}`;
    }
    if (end !== -1 && end < start) {
      return `Error: Invalid \`view_range\`: [${start}, ${end}]. Second element should be >= first`;
    }

    initLine = start;
    content =
      end === -1
        ? lines.slice(start - 1).join("\n")
        : lines.slice(start - 1, end).join("\n");
  }

  return formatWithLineNumbers(content, path, initLine);
}

async function createCommand(path: string, fileText: string): Promise<string> {
  const o = op();
  if (await o.exists(path)) {
    return `Error: File already exists at: ${path}. Cannot overwrite files using command \`create\`.`;
  }
  await o.writeFile(path, fileText);
  // Save to history for undo
  if (!fileHistory.has(path)) fileHistory.set(path, []);
  fileHistory.get(path)!.push({ kind: "create" });
  return `File created successfully at: ${path}`;
}

async function strReplaceCommand(
  path: string,
  oldStr: string,
  newStr: string
): Promise<string> {
  const o = op();
  const content = await o.readFile(path);

  // Count occurrences — must be exactly 1
  const occurrences = content.split(oldStr).length - 1;

  if (occurrences === 0) {
    return `Error: No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${path}.`;
  }
  if (occurrences > 1) {
    // Find line numbers of occurrences (matches Python logic)
    const lines = content.split("\n");
    const matchLines = lines
      .map((line, idx) => (line.includes(oldStr) ? idx + 1 : -1))
      .filter((n) => n !== -1);
    return `Error: No replacement was performed. Multiple occurrences of old_str in lines ${JSON.stringify(matchLines)}. Please ensure it is unique`;
  }

  // Perform replacement
  const newContent = content.replace(oldStr, newStr);
  await o.writeFile(path, newContent);

  // Save original to history for undo
  if (!fileHistory.has(path)) fileHistory.set(path, []);
  fileHistory.get(path)!.push({ kind: "edit", previousContent: content });

  // Create snippet of edited section
  const replacementLine = content.split(oldStr)[0].split("\n").length - 1;
  const startLine = Math.max(0, replacementLine - SNIPPET_LINES);
  const endLine =
    replacementLine + SNIPPET_LINES + newStr.split("\n").length - 1;
  const snippet = newContent
    .split("\n")
    .slice(startLine, endLine + 1)
    .join("\n");

  let msg = `The file ${path} has been edited. `;
  msg += formatWithLineNumbers(
    snippet,
    `a snippet of ${path}`,
    startLine + 1
  );
  msg +=
    "Review the changes and make sure they are as expected. Edit the file again if necessary.";
  return msg;
}

async function insertCommand(
  path: string,
  insertLine: number,
  newStr: string
): Promise<string> {
  const o = op();
  const content = await o.readFile(path);

  const lines = content.split("\n");
  const nLines = lines.length;

  if (insertLine < 0 || insertLine > nLines) {
    return `Error: Invalid \`insert_line\` parameter: ${insertLine}. Should be within [0, ${nLines}]`;
  }

  const newStrLines = newStr.split("\n");
  const newLines = [
    ...lines.slice(0, insertLine),
    ...newStrLines,
    ...lines.slice(insertLine),
  ];

  // Create snippet for preview
  const snippetLines = [
    ...lines.slice(Math.max(0, insertLine - SNIPPET_LINES), insertLine),
    ...newStrLines,
    ...lines.slice(insertLine, insertLine + SNIPPET_LINES),
  ];

  const newContent = newLines.join("\n");
  await o.writeFile(path, newContent);

  // Save original to history
  if (!fileHistory.has(path)) fileHistory.set(path, []);
  fileHistory.get(path)!.push({ kind: "edit", previousContent: content });

  const snippet = snippetLines.join("\n");
  let msg = `The file ${path} has been edited. `;
  msg += formatWithLineNumbers(
    snippet,
    "a snippet of the edited file",
    Math.max(1, insertLine - SNIPPET_LINES + 1)
  );
  msg +=
    "Review the changes and make sure they are as expected (correct indentation, no duplicate lines, etc). Edit the file again if necessary.";
  return msg;
}

async function undoEditCommand(path: string): Promise<string> {
  const history = fileHistory.get(path);
  if (!history || history.length === 0) {
    return `Error: No edit history found for ${path}.`;
  }

  const entry = history.pop()!;
  const fileOp = op();

  if (entry.kind === "create") {
    await fileOp.deleteFile(path);
    return `Last edit to ${path} undone successfully. The file has been removed.`;
  }

  const oldText = entry.previousContent ?? "";
  await fileOp.writeFile(path, oldText);
  return `Last edit to ${path} undone successfully. ${formatWithLineNumbers(oldText, path)}`;
}

// ---- Main tool ----

export const strReplaceEditor = tool(
  async ({
    command,
    path,
    fileText,
    oldStr,
    newStr,
    insertLine,
    viewRange,
  }): Promise<string> => {
    // Validate absolute path
    if (!path.startsWith("/")) {
      return `Error: The path ${path} is not an absolute path.`;
    }

    // S-3: Path boundary check — reject paths outside workspace (now symlink-aware)
    const boundaryError = await checkPathBoundary(path);
    if (boundaryError) {
      return `Error: ${boundaryError}`;
    }

    const o = op();

    // For non-create commands, check path exists
    if (command !== "create") {
      if (!(await o.exists(path))) {
        return `Error: The path ${path} does not exist. Please provide a valid path.`;
      }
      if ((await o.isDirectory(path)) && command !== "view") {
        return `Error: The path ${path} is a directory and only the \`view\` command can be used on directories`;
      }
    }

    switch (command) {
      case "view":
        return viewCommand(path, viewRange && viewRange.length > 0 ? viewRange : undefined);

      case "create":
        if (!fileText) {
          return "Error: Parameter `file_text` is required for command: create";
        }
        return createCommand(path, fileText);

      case "str_replace":
        if (!oldStr) {
          return "Error: Parameter `old_str` is required for command: str_replace";
        }
        return strReplaceCommand(path, oldStr, newStr ?? "");

      case "insert":
        if (insertLine === undefined || insertLine === null) {
          return "Error: Parameter `insert_line` is required for command: insert";
        }
        if (!newStr) {
          return "Error: Parameter `new_str` is required for command: insert";
        }
        return insertCommand(path, insertLine, newStr);

      case "undo_edit":
        return undoEditCommand(path);

      default:
        return `Error: Unrecognized command ${command}. Allowed: view, create, str_replace, insert, undo_edit`;
    }
  },
  {
    name: "str_replace_editor",
    description: `Custom editing tool for viewing, creating and editing files.
* State is persistent across command calls and discussions with the user
* If \`path\` is a file, \`view\` displays the result of applying \`cat -n\`. If \`path\` is a directory, \`view\` lists non-hidden files and directories up to 2 levels deep
* The \`create\` command cannot be used if the specified \`path\` already exists as a file
* If a \`command\` generates a long output, it will be truncated and marked with \`<response clipped>\`
* The \`undo_edit\` command will revert the last edit made to the file at \`path\`

Notes for using the \`str_replace\` command:
* The \`old_str\` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!
* If the \`old_str\` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in \`old_str\` to make it unique
* The \`new_str\` parameter should contain the edited lines that should replace the \`old_str\``,
    schema: z.object({
      command: z
        .enum(["view", "create", "str_replace", "insert", "undo_edit"])
        .describe("The command to run."),
      path: z
        .string()
        .describe("Absolute path to file or directory."),
      fileText: z
        .string()
        .default("")
        .describe(
          "Required for `create` command: the content of the file to be created."
        ),
      oldStr: z
        .string()
        .default("")
        .describe(
          "Required for `str_replace` command: the string in `path` to replace."
        ),
      newStr: z
        .string()
        .default("")
        .describe(
          "For `str_replace`: the replacement string. For `insert`: the string to insert."
        ),
      insertLine: z
        .number()
        .default(-1)
        .describe(
          "Required for `insert` command. The `new_str` will be inserted AFTER this line number (0-based)."
        ),
      viewRange: z
        .array(z.number())
        .default([])
        .describe(
          "Optional for `view` command: [start_line, end_line] (1-based). Use -1 for end_line to show to end of file."
        ),
    }),
  }
);
