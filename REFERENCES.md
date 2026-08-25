# 参考与致谢

`MVU转数据库` 的兼容判断来自上游源码、公开接口资料和社区角色卡写法。不同资料的权威程度不同：运行时行为以对应版本源码为准，教程主要用于识别卡作者实际采用的结构和提示词习惯。

## 上游实现与接口

- [MagVarUpdate](https://github.com/MagicalAstrogy/MagVarUpdate)：MVU 初始化、变量结构、更新命令、事件顺序与 `Mvu.*` 接口的主要依据。项目采用 MIT 许可证。
- [酒馆助手（JS-Slash-Runner）](https://github.com/N0VI028/JS-Slash-Runner)：角色脚本、变量、事件、消息 iframe 与 EJS 运行环境的接口依据。
- [SillyTavern](https://github.com/SillyTavern/SillyTavern)：角色卡、世界书、宏、聊天消息和扩展宿主行为的上游项目。
- SP·数据库：模板、SyncBridge、SQLite 物化和表格 API 以维护时使用的明确版本源码快照为准；当前兼容基线为 v8.9.2。本项目与该插件相互独立，不包含其源码。

## 教程与社区资料

- [手写 MVU zod 变量卡](https://stagedog.github.io/%E7%BB%9C%E7%BB%9C/%E6%95%99%E7%A8%8B/%E6%89%8B%E5%86%99mvu%E5%8F%98%E9%87%8F%E5%8D%A1/)：用于核对当前社区常见的 Zod Schema、InitVar、变量提示词、脚本和状态栏写法。
- 来源不明且已过时的旧版 MVU、提示词模板和 `config` 教程不纳入引用链；历史写法改由上游源码中的旧教程、类型声明和真实角色卡样例取证。
- 工作区中的参考角色卡只作为行为对照与回归样例；转换器不会针对其中的卡名、角色名或固定字段编写特例。

感谢上述项目维护者、文档作者和社区示例贡献者。若教程建议与上游运行时源码冲突，本项目优先遵循源码，并在兼容清单中记录不能等价转换的部分。
