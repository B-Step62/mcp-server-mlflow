import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListPromptsRequestSchema,
  ListPromptsRequest,
  ListPromptsResult,
  GetPromptRequestSchema,
  GetPromptRequest,
  GetPromptResult,
  CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import axios from "axios";

// Constants for MLflow
const IS_PROMPT_TAG_NAME = "mlflow.prompt.is_prompt";
const IS_PROMPT_TAG_VALUE = "true";
const PROMPT_CONTENT_TAG_KEY = "mlflow.prompt.text";
const MLFLOW_TRACKING_URI = process.env.MLFLOW_TRACKING_URI || "http://localhost:5000";
const PROMPT_VARIABLE_REGEX = /\{\{\s*(.*?)\s*\}\}/g;


// Create MCP server instance with a "prompts" capability
const server = new McpServer(
  {
    name: "mlflow-prompts",
    version: "1.0.0",
  },
  {
    capabilities: {
      prompts: {},
    },
  }
);

// MLflow API Client
const mlflowApi = {
  listRegisteredPrompts: async (searchFilter?: string, pageToken?: string) => {
    try {
      const params = new URLSearchParams();
      let filter = `tags.\`${IS_PROMPT_TAG_NAME}\` = '${IS_PROMPT_TAG_VALUE}'`;

      if (searchFilter) {
        filter = `${filter} AND name ILIKE '%${searchFilter}%'`;
      }

      if (pageToken) {
        params.append("page_token", pageToken);
      }

      params.append("filter", filter);

      const response = await axios.get(
        `${MLFLOW_TRACKING_URI}/ajax-api/2.0/mlflow/registered-models/search?${params.toString()}`
      );

      return response.data;
    } catch (error) {
      console.error("Error fetching prompts:", error);
      throw new Error("Failed to fetch prompts");
    }
  },

  getPromptDetails: async (promptName: string) => {
    try {
      const params = new URLSearchParams();
      params.append("name", promptName);

      const response = await axios.get(
        `${MLFLOW_TRACKING_URI}/ajax-api/2.0/mlflow/registered-models/get?${params.toString()}`
      );

      return response.data.registered_model;
    } catch (error) {
      console.error(`Error fetching prompt details for '${promptName}':`, error);
      throw new Error(`Failed to fetch prompt details for '${promptName}'`);
    }
  },

  getPromptVersions: async (promptName: string) => {
    try {
      const params = new URLSearchParams();
      params.append(
        "filter",
        `name='${promptName}' AND tags.\`${IS_PROMPT_TAG_NAME}\` = '${IS_PROMPT_TAG_VALUE}'`
      );

      const response = await axios.get(
        `${MLFLOW_TRACKING_URI}/ajax-api/2.0/mlflow/model-versions/search?${params.toString()}`
      );

      return response.data.model_versions || [];
    } catch (error) {
      console.error(`Error fetching prompt versions for '${promptName}':`, error);
      throw new Error(`Failed to fetch prompt versions for '${promptName}'`);
    }
  },

  getLatestPromptVersion: async (promptName: string) => {
    const versions = await mlflowApi.getPromptVersions(promptName);
    if (!versions || versions.length === 0) {
      throw new Error(`No versions found for prompt '${promptName}'`);
    }

    // Get the latest version (highest version number)
    return versions.reduce((latest: any, current: any) => {
      return parseInt(current.version) > parseInt(latest.version) ? current : latest;
    }, versions[0]);
  },

  getPromptContent: async (promptName: string) => {
    const latestVersion = await mlflowApi.getLatestPromptVersion(promptName);
    const promptContentTag = latestVersion.tags.find(
      (tag: { key: string, value: string }) => tag.key === PROMPT_CONTENT_TAG_KEY
    );

    if (!promptContentTag) {
      throw new Error(`No content found for prompt '${promptName}'`);
    }

    return promptContentTag.value;
  }
};

// Convert the specified variables in the template with actual values
function compilePrompt(template: string, variables: Record<string, string> = {}): string {
  let compiledPrompt = template;

  // Replace all variables in the template
  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`{{\\s*${key}\\s*}}`, "g");
    compiledPrompt = compiledPrompt.replace(regex, value);
  }

  return compiledPrompt;
}

// Function to handle the list prompts request
async function listPromptsHandler(
  request: ListPromptsRequest
): Promise<ListPromptsResult> {
  try {
    const cursor: string | undefined = request.params?.cursor;
    // @ts-ignore
    const searchFilter: string | undefined = request.params?.filter;

    const response = await mlflowApi.listRegisteredPrompts(searchFilter, cursor);
    const registeredPrompts = response.registered_models || [];

    const resPrompts: ListPromptsResult["prompts"] = await Promise.all(
      registeredPrompts.map(async (prompt: any) => {
        try {
          const promptContent = await mlflowApi.getPromptContent(prompt.name);
          const variables = extractVariables(promptContent);

          return {
            name: prompt.name,
            arguments: variables.map((v) => ({
              name: v,
              required: false,
            })),
          };
        } catch (error) {
          console.error(`Error processing prompt '${prompt.name}':`, error);
          // Return the prompt with no arguments if we failed to process it
          return {
            name: prompt.name,
            arguments: [],
          };
        }
      })
    );

    return {
      prompts: resPrompts,
      nextCursor: response.next_page_token,
    };
  } catch (error) {
    console.error("Error in listPromptsHandler:", error);
    throw new Error("Failed to list prompts");
  }
}

// Function to handle the get prompt request
async function getPromptHandler(
  request: GetPromptRequest
): Promise<GetPromptResult> {
  const promptName: string = request.params.name;
  const args = request.params.arguments || {};

  try {
    const promptContent = await mlflowApi.getPromptContent(promptName);
    const compiledPrompt = compilePrompt(promptContent, args);

    // For now, treat all MLflow prompts as text prompts (user messages)
    // This could be enhanced to support chat prompts if MLflow adds that capability
    const result: GetPromptResult = {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: compiledPrompt,
          },
        },
      ],
    };

    return result;
  } catch (error: any) {
    throw new Error(`Failed to get prompt for '${promptName}': ${error.message}`);
  }
}

export function extractVariables(mustacheString: string): string[] {
  const matches = Array.from(mustacheString.matchAll(PROMPT_VARIABLE_REGEX))
    .map((match) => match[1].trim())
    .filter((match) => match.length > 0);
  return [...new Set(matches)];
}

// Register handlers
server.server.setRequestHandler(ListPromptsRequestSchema, listPromptsHandler);
server.server.setRequestHandler(GetPromptRequestSchema, getPromptHandler);

// Tools for compatibility
server.tool(
  "list-prompts",
  "List prompts that are stored in MLflow",
  {
    cursor: z.string().optional().describe("Cursor to paginate through prompts"),
    filter: z.string().optional().describe("Filter to search for prompts"),
  },
  async (args) => {
    try {
      const res = await listPromptsHandler({
        method: "prompts/list",
        params: {
          cursor: args.cursor,
          filter: args.filter,
        },
      });

      const parsedRes: CallToolResult = {
        content: res.prompts.map((p) => ({
          type: "text",
          text: JSON.stringify(p),
        })),
      };

      return parsedRes;
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: "Error: " + error,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "get-prompt",
  "Get a prompt that is stored in MLflow",
  {
    name: z.string().describe(
      "Name of the prompt to retrieve, use list-prompts to get a list of prompts"
    ),
    arguments: z
      .record(z.string())
      .optional()
      .describe(
        'Arguments with prompt variables to pass to the prompt template, json object, e.g. {"<name>":"<value>"}'
      ),
  },
  async (args) => {
    try {
      const res = await getPromptHandler({
        method: "prompts/get",
        params: {
          name: args.name,
          arguments: args.arguments,
        },
      });

      const parsedRes: CallToolResult = {
        content: [
          {
            type: "text",
            text: JSON.stringify(res),
          },
        ],
      };

      return parsedRes;
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: "Error: " + error,
          },
        ],
        isError: true,
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MLflow Prompts MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});