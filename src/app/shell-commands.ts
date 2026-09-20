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
    name: "/init",
    description: "初始化 CityBrain 项目工作区（citybrain/ 目录骨架）",
    argumentHint: "[<target-folder>]",
  },
  {
    name: "/sandbox",
    description: "查看或配置工作区级 sandbox 读写边界",
    argumentHint: "[add-read|remove-read <directory>]",
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
