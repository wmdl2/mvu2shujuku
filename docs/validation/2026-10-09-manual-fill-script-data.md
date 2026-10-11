# 脚本兜底数据与手动填表路径（2026-10-09）

用户要求核对：若未映射脚本数据放入一张 JSON 表，设置更新频率为 0 能否保护它。此次只检查源码和实际选表函数，不改产品、不启动酒馆；两种存储方案仍待决定。

## 固定版本与结论

以此前实测数据库1.2.6的 commit `33757c141f6e3df768efc50f7eef372ceaedf50a` 为准，直接读取该 Git 对象，未混用当前参考库3c5c1ec…源码。产品保持 `e2687e67…`，868项回归结论未变化。

更新频率0只排除自动调度，不排除手动重填或手动追平。手动选表默认全选；面板“全选”也包括此类表。显式取消选择有效，但再次全选会重新纳入，因此不能把默认取消选择当作可靠保护。

| 入口 | 实际调用链 | 频率0表的行为 |
| --- | --- | --- |
| 公开 `manualUpdate()` / 旧手动按钮 | `createSettingsConfigApi.manualUpdate` → `handleManualUpdate_ACU` → `getSelectedManualTableKeys_ACU` → `orchestrateManualUpdate_ACU` | 被选中即进入重填；自动更新频率不参与手动分组 |
| V2面板手动重填 | `useManualUpdate` → `orchestrateManualUpdate_ACU` | 直接调用内部服务，绕过公开API；确认后按已选表清理范围内旧数据 |
| V2面板一键追平 | `useManualUpdate` → `orchestrateManualCatchUp_ACU` → `prepareManualCatchUpPlan_ACU` | 同一选表集合；有未追平范围时可进入模型任务，已追平则可返回no_work |

## 关键依据

以下路径均为上述固定数据库 commit 内的上游源码路径。

- `src/service/table/update-scheduler.ts:130`：只有 `frequency > 0` 的表加入自动待更新集合；随后分组也只使用该集合。
- `src/service/settings/settings-readers.ts:84`：未设置手动选择时返回全部可用表；显式设置时仅按表键存在性筛选。
- `src/presentation-v2/composables/useManualUpdate.ts:109`：执行表键来自真实运行时；`:133` 默认全选；`:450` “全选”重新写入全部运行时表键。没有频率0排除规则。
- 同文件 `:539` 与 `:668`：重填与追平分别直接调用内部 orchestrator，包装 `AutoCardUpdaterAPI.manualUpdate` 无法覆盖这两个入口。
- `src/service/table/update-orchestrator.ts:5020`：明确将更新频率、自动上下文深度及表级跳层排除出手动调度参数。
- 同文件 `:5150` 附近调用 `clearManualRefillSheetDataInRange_ACU`，清理所选范围内所选表的 checkpoint 与增量，随后重建；“请模型不要修改”无法防止模型请求之前的清理。首批提交前失败可恢复旧数据，不代表成功重填会保留脚本数据。
- `src/service/chat/chat-service.ts:2944` 清理实际选择的表键，没有按更新频率或单元格锁排除；`:2442` 将候选修改应用到消息的数据库隔离数据与身份字段，不替换原消息变量。
- `src/presentation/bootstrap/api-groups/settings-config-api.ts:211` 附近提供 `setManualSelectedTables`，可设置默认排除，但用户全选仍可重新选择。单元格/列锁也不是替代方案：公开CRUD的 `updateCell/updateRow` 检查同一套锁，会限制作者脚本写入；手动重填预清理则另走历史清理路径。

## 验证范围

使用 Node22的TypeScript去类型与Acorn，从固定上游源码提取实际选表函数，在VM中执行；可用表键为固定输入，一张频率1表、一张频率0表。

三组检查通过：默认全选包含频率0表；显式取消选择时排除；V2“全选”重新选入且保存。这个检查证明选表函数行为，不是完整宿主、历史清理或模型质量验收。

私有过程证据：`.tools/card-playcheck-2026-10-08/manual-selection-check.js`、`manual-selection-results.json`。冻结输入SHA-256：settings-readers为 `063d34e5144e1cfedb27909f256644e495e85bba09cd4f43a5e8a27ae04bb29c`；useManualUpdate为 `822593c4722939682fedd14a35804828535c4a75f4ea5b72059c60b11ab4265b`。

## 对方案的影响

仅新增表并设置频率0，不足以稳定保存仅脚本管理的数据。可靠的数据库兜底表需要在手动重填、追平、选表与历史清理入口明确排除；当前已核对的入口不识别这类保护标记。DOM按钮拦截、包装单一公开API或事后恢复数据都不能替代执行前的目标排除。

因此在不修改数据库源码、没有已确认的脚本专用受保护存储接口的范围内，建议优先将未映射部分保留在原消息变量 `variables[swipe].stat_data`，由兼容层与数据库字段合并。它仍需解决普通变量替换、删除、历史读取和会话守卫，但无需借助手动选表偏好保护数据。此为建议，尚未获用户选择、尚未实施。
