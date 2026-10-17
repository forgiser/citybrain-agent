export interface ShellCommand {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
}

export const shellCommands: ShellCommand[] = [
  {
    name: "/new",
    description: "开启一个新的对话消息",
  },
  {
    name: "/help",
    description: "展示可用的命令",
  },
  {
    name: "/clear",
    description: "清楚当前的对话内容",
  },
  {
    name: "/resume",
    description: "恢复之前的对话消息",
  },
  {
    name: "/model",
    description: "选择当前的模型",
    argumentHint: "<provider/model>",
  },
  {
    name: "/thinking",
    description: "设置当前的思考等级",
    argumentHint: "<off|high|max>",
  },
  {
    name: "/qgis",
    description: "检测或配置已有的 QGIS Processing 环境",
    argumentHint: "[setup|detect|list [filter]|info <algo>|use <path>|clear]",
  },
  {
    name: "/workspace",
    description: "创建、切换或查看当前 CityBrain 工作区",
    argumentHint: "[<path>|info|add-read|remove-read]",
  },
  {
    name: "/login",
    description: "保存一个供应商 API密钥",
    argumentHint: "<provider>",
  },
  {
    name: "/logout",
    description: "删除保存的供应商 API密钥",
    argumentHint: "<provider>",
  },
  {
    name: "/session",
    description: "展示当前会话的信息",
  },
  {
    name: "/observe",
    description: "查看 Agent 全链路观测摘要、运行、工具、错误或时间线",
    argumentHint: "[summary|runs|tools|errors|timeline] [limit]",
    aliases: ["/obs"],
  },
  {
    name: "/workflow",
    description: "从 Run 生成、查看并执行可复现的空间分析工作流",
    argumentHint: "[list|draft <runId>|show <workflowId>|run <workflowId>|status <workflowId>]",
  },
  {
    name: "/eval",
    description: "列出 GIS 基准用例或评测当前工作区中已完成的 Run",
    argumentHint: "[cases|run <caseId> <runId>]",
  },
  {
    name: "/quit",
    description: "退出CityBrain",
    aliases: ["/exit"],
  },
];

export function findShellCommand(input: string): ShellCommand | undefined {
  const [name] = input.toLowerCase().split(/\s+/, 1);
  return shellCommands.find((command) => {
    return command.name === name || command.aliases?.includes(name);
  });
}
