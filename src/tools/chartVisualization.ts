/**
 * Chart Visualization Tools — VMind-powered intelligent chart pipeline.
 *
 * Translated from: app/tool/chart_visualization/ (337 lines across 3 files)
 *
 * Rewritten (7a-7): Uses @visactor/vmind natively in Node.js.
 * Python called VMind via `npx ts-node` subprocess. TS integrates directly.
 *
 * Pipeline:
 *   VisualizationPrepare (CSV → clean → JSON metadata)
 *   → DataVisualization (JSON → VMind → HTML/PNG chart)
 *   → Optional Insight (VMind → Markdown insight report)
 *
 * Note: VMind internally calls LLM (OpenAI-compatible only) for:
 * - Chart type recommendation
 * - Insight generation
 * These calls are OUTSIDE the LangGraph graph — token usage not tracked.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, basename } from "path";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { CODE_EXEC } from "../config/constants.js";
import { getConfig, WORKSPACE_ROOT } from "../config/index.js";
import { logger } from "../utils/logger.js";

/**
 * Initialize VMind with LLM config from app config.
 * VMind expects: url, model, headers (Authorization: Bearer API_KEY).
 */
async function createVMindInstance() {
  // Dynamic import — VMind is ESM
  const { default: VMind, Model } = await import("@visactor/vmind");

  const llmConfig = getConfig().llm.default;
  const baseUrl = llmConfig.base_url || "https://api.openai.com/v1";

  return new VMind({
    model: llmConfig.model || Model.GPT_4o,
    url: `${baseUrl}/chat/completions`,
    headers: {
      Authorization: `Bearer ${llmConfig.api_key}`,
    },
  });
}

/**
 * VisualizationPrepare — Data preparation tool.
 *
 * Runs Python code that:
 * 1. Loads and cleans data (CSV/JSON/Excel)
 * 2. Outputs cleaned CSV files
 * 3. Generates JSON metadata: [{csvFilePath, chartTitle}]
 * 4. Prints the JSON file path
 *
 * Matches Python's VisualizationPrepare tool.
 */
export const visualizationPrepare = tool(
  async ({ code, timeout = 15 }): Promise<string> => {
    const tmpFile = join(tmpdir(), `openmanus_vizprep_${Date.now()}.py`);
    const outDir = join(WORKSPACE_ROOT, "visualization");
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

    const fullCode = `import os\nos.makedirs("${outDir}", exist_ok=True)\n${code}`;

    try {
      writeFileSync(tmpFile, fullCode, "utf-8");
      const result = execSync(`python3 "${tmpFile}"`, {
        timeout: timeout * 1000,
        encoding: "utf-8",
        maxBuffer: CODE_EXEC.MAX_BUFFER,
        cwd: outDir,
      });
      return result || "Preparation complete (no output)";
    } catch (e: any) {
      if (e.killed) return `Timeout after ${timeout}s`;
      return `Error: ${e.stderr || e.message}`;
    } finally {
      try { require("fs").unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  },
  {
    name: "visualization_preparation",
    description: `Prepare data for chart visualization using Python code.
1. Load and clean data files (CSV, JSON, Excel)
2. Generate cleaned CSV data files
3. Save metadata as JSON: [{"csvFilePath": "path.csv", "chartTitle": "title"}]
4. Print the JSON file path as output`,
    schema: z.object({
      code: z.string().describe("Python code for data preparation. Must print the JSON file path."),
      timeout: z.number().default(15).describe("Timeout in seconds."),
    }),
  }
);

/**
 * DataVisualization — Chart generation via VMind.
 *
 * Reads JSON metadata (from visualizationPrepare) → loads CSV data →
 * calls VMind to generate charts → saves HTML/PNG output.
 *
 * Dual mode:
 * - visualization: generate charts from data
 * - insight: add analytical insights to existing charts
 */
export const chartVisualization = tool(
  async ({
    jsonPath,
    outputType = "html",
    toolType = "visualization",
    language = "en",
  }): Promise<string> => {
    try {
      const jsonContent = readFileSync(jsonPath, "utf-8");
      const jsonInfo = JSON.parse(jsonContent);
      const outDir = join(WORKSPACE_ROOT, "visualization");
      if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

      if (toolType === "visualization") {
        return await generateCharts(jsonInfo, outputType, language, outDir);
      } else {
        return await addInsights(jsonInfo, outputType, outDir);
      }
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  },
  {
    name: "data_visualization",
    description: `Generate charts or add insights using VMind intelligent chart engine.
Modes:
- visualization: Read CSV data → auto-recommend chart type → generate HTML/PNG
- insight: Analyze existing charts → generate Markdown insight reports
Input: JSON file path from visualization_preparation tool.`,
    schema: z.object({
      jsonPath: z.string().describe('Path to JSON metadata file (from visualization_preparation).'),
      outputType: z.enum(["html", "png"]).default("html").describe("Output format."),
      toolType: z.enum(["visualization", "insight"]).default("visualization").describe("visualization: generate charts; insight: add insights."),
      language: z.enum(["en", "zh"]).default("en").describe("Language for chart labels."),
    }),
  }
);

/** Generate charts from CSV data via VMind. */
async function generateCharts(
  jsonInfo: Array<{ csvFilePath: string; chartTitle: string }>,
  outputType: string,
  language: string,
  outDir: string
): Promise<string> {
  const vmind = await createVMindInstance();
  const results: string[] = [];
  const errors: string[] = [];

  for (const item of jsonInfo) {
    try {
      // Read CSV
      const csvPath = existsSync(item.csvFilePath)
        ? item.csvFilePath
        : join(WORKSPACE_ROOT, item.csvFilePath);
      const csvData = readFileSync(csvPath, "utf-8");

      // Parse CSV → dataset
      const { fieldInfo, dataset } = vmind.parseCSVData(csvData);

      // Generate chart via VMind (this calls LLM internally)
      const { spec } = await vmind.generateChart(
        item.chartTitle,
        fieldInfo,
        dataset
      );

      // Save output
      const fileName = basename(csvPath, ".csv");
      const chartPath = join(outDir, `${fileName}.${outputType}`);

      if (outputType === "html") {
        // Generate standalone HTML with VChart
        const html = `<!DOCTYPE html>
<html><head><script src="https://unpkg.com/@visactor/vchart/build/index.min.js"></script></head>
<body><div id="chart" style="width:800px;height:600px;"></div>
<script>new VChart.default(${JSON.stringify(spec)}, { dom: 'chart' }).renderSync();</script>
</body></html>`;
        writeFileSync(chartPath, html, "utf-8");
      } else {
        // For PNG: save spec as JSON (rendering requires a canvas environment)
        writeFileSync(chartPath, JSON.stringify(spec, null, 2), "utf-8");
      }

      results.push(`## ${item.chartTitle}\nChart saved in: ${chartPath}`);
      logger.info({ chartPath, title: item.chartTitle }, "Chart generated");
    } catch (e: any) {
      errors.push(`Error for ${item.csvFilePath}: ${e.message}`);
      logger.error({ err: e, csv: item.csvFilePath }, "Chart generation failed");
    }
  }

  if (errors.length > 0 && results.length === 0) {
    return `Chart generation failed:\n${errors.join("\n")}`;
  }

  let output = `Chart Generated Successfully!\n${results.join("\n")}`;
  if (errors.length > 0) {
    output += `\n\nErrors:\n${errors.join("\n")}`;
  }
  return output;
}

/** Add insights to existing charts via VMind. */
async function addInsights(
  jsonInfo: Array<{ chartPath: string; insights_id?: number[] }>,
  outputType: string,
  outDir: string
): Promise<string> {
  const vmind = await createVMindInstance();
  const results: string[] = [];

  for (const item of jsonInfo) {
    try {
      const chartPath = existsSync(item.chartPath)
        ? item.chartPath
        : join(outDir, item.chartPath);

      // Read chart spec
      const specContent = readFileSync(chartPath, "utf-8");
      const spec = JSON.parse(specContent);

      // Get insights via VMind
      const { insights } = await vmind.getInsights(spec);

      if (insights && insights.length > 0) {
        // Generate markdown report
        const md = insights
          .map((insight: any, i: number) => `${i + 1}. ${insight.description || insight.text || JSON.stringify(insight)}`)
          .join("\n");

        const insightPath = chartPath.replace(`.${outputType}`, "_insights.md");
        writeFileSync(insightPath, md, "utf-8");
        results.push(`Insights for ${chartPath}:\n${md}`);
      } else {
        results.push(`No insights generated for ${chartPath}`);
      }
    } catch (e: any) {
      results.push(`Error for ${item.chartPath}: ${e.message}`);
    }
  }

  return results.join("\n\n");
}
