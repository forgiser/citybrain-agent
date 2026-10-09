export type AgentHostMode = "cli" | "web" | "api";

export type AgentCapability =
  | "filesystem"
  | "qgis"
  | "background_tasks"
  | "subagents"
  | "terminal_ui"
  | "web_ui"
  | "map_view"
  | "map_layers"
  | "map_selection"
  | "map_commands";

export interface HostPromptContext {
  mapStateSummary?: string;
  visualizationStateSummary?: string;
}

export interface HostPromptContribution {
  id: string;
  volatility: "static" | "volatile";
  reason?: string;
  contribute(context: HostPromptContext): string | undefined;
}

export interface AgentHostProfile {
  mode: AgentHostMode;
  label: string;
  capabilities: readonly AgentCapability[];
  promptContributors: readonly HostPromptContribution[];
}

export interface ResolvedHostPrompt {
  staticSections: Array<{ id: string; content: string }>;
  volatileSections: Array<{ id: string; content: string; reason: string }>;
}

export function createAgentHostProfile(mode: AgentHostMode): AgentHostProfile {
  const commonCapabilities = [
    "filesystem",
    "qgis",
    "background_tasks",
    "subagents",
  ] satisfies AgentCapability[];

  if (mode === "web") {
    return {
      mode,
      label: "Web UI",
      capabilities: [
        ...commonCapabilities,
        "web_ui",
        "map_view",
        "map_layers",
        "map_selection",
        "map_commands",
      ],
      promptContributors: [
        hostEnvironmentContributor("web", "Web UI", [
          ...commonCapabilities,
          "web_ui",
          "map_view",
          "map_layers",
          "map_selection",
          "map_commands",
        ]),
        {
          id: "web_map_contract",
          volatility: "static",
          contribute: () => [
            "You are connected to a Web UI that contains a MapLibre map.",
            "The map state supplied below is observational context, not proof that a map command was executed.",
            "Only change the map through map tools that are actually present in the current tool list.",
            "Files are never loaded onto the map implicitly. Use map_add_layer only when the user explicitly asks to display a GeoJSON file.",
            "Use map_list_layers or map_get_state to inspect layers, map_remove_layer to remove one, map_set_layer_visibility to show or hide one, map_set_view to move the map, and map_fit_layer to zoom to a loaded layer.",
            "If no map command tool is available, explain the intended map action instead of claiming it happened.",
            "Do not request or embed complete GeoJSON in the system prompt; query detailed data through tools when available.",
          ].join("\n"),
        },
        {
          id: "web_map_state",
          volatility: "volatile",
          reason: "the browser viewport, layers, and selection can change between model requests",
          contribute: (context) => context.mapStateSummary ?? [
            "Current map state: no active Web map client has reported state.",
            "Treat viewport, visible layers, and selection as unknown.",
          ].join("\n"),
        },
        {
          id: "web_visualization_state",
          volatility: "volatile",
          reason: "the user can open, close, and activate visualization tabs between model requests",
          contribute: (context) => context.visualizationStateSummary ?? [
            "Current visualization workspace: no active Web client has reported open views.",
            "Do not assume that a file or visualization is currently visible.",
          ].join("\n"),
        },
      ],
    };
  }

  if (mode === "api") {
    return {
      mode,
      label: "API",
      capabilities: commonCapabilities,
      promptContributors: [hostEnvironmentContributor(mode, "API", commonCapabilities)],
    };
  }

  return {
    mode: "cli",
    label: "CLI",
    capabilities: [...commonCapabilities, "terminal_ui"],
    promptContributors: [
      hostEnvironmentContributor("cli", "CLI", [...commonCapabilities, "terminal_ui"]),
      {
        id: "cli_interaction_contract",
        volatility: "static",
        contribute: () => [
          "The user is interacting through a terminal UI.",
          "No browser map viewport, map selection, or client-side map command channel is available.",
        ].join("\n"),
      },
    ],
  };
}

export function hasHostCapability(
  profile: AgentHostProfile,
  capability: AgentCapability,
): boolean {
  return profile.capabilities.includes(capability);
}

export function resolveHostPrompt(
  profile: AgentHostProfile,
  context: HostPromptContext = {},
): ResolvedHostPrompt {
  const resolved: ResolvedHostPrompt = {
    staticSections: [],
    volatileSections: [],
  };
  for (const contributor of profile.promptContributors) {
    const content = contributor.contribute(context)?.trim();
    if (!content) continue;
    if (contributor.volatility === "static") {
      resolved.staticSections.push({ id: contributor.id, content });
    } else {
      resolved.volatileSections.push({
        id: contributor.id,
        content,
        reason: contributor.reason ?? "host state can change between model requests",
      });
    }
  }
  return resolved;
}

function hostEnvironmentContributor(
  mode: AgentHostMode,
  label: string,
  capabilities: readonly AgentCapability[],
): HostPromptContribution {
  return {
    id: `host_environment_${mode}`,
    volatility: "static",
    contribute: () => [
      `Host mode: ${label} (${mode}).`,
      `Host capabilities: ${capabilities.join(", ")}.`,
      "The concrete tool list in the current model request is authoritative; never invent a capability-specific tool.",
    ].join("\n"),
  };
}
