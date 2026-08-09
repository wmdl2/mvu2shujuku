# MVU转数据库（SillyTavern 原生扩展）

把 MVU 变量角色卡转换为 SP·数据库（AutoCardUpdater / shujuku）角色卡。

## 安装
1. 将本目录放入 `data/<user>/extensions/mvu2db-converter/`（或全局 `public/scripts/extensions/third-party/`）。
2. 重启 SillyTavern 或刷新页面。
3. 前提：已安装 SP·数据库插件（AutoCardUpdater 8.9.1）。

## 使用
1. 打开扩展设置面板。
2. 选择模式（双模式 / native / sqlite），选择输入（当前角色卡或文件）。
3. 点击转换，下载 角色卡 + 表格模板 JSON + 转换报告。

## 说明
- 转换不自动安装数据库插件；不迁移旧聊天；只转换角色卡本身。
- 表格模板不会写入世界书条目，改为内嵌到卡内数据桥脚本，开局自动建表。
- 状态栏继续通过 getAllVariables() 读取 stat_data；数据桥会把数据库表格重建为 stat_data 形状。
- 卡内 MVU 相关正则/脚本/更新规则会被移除；依赖 Mvu API 的脚本通过 Mvu 兼容层尽力适配。