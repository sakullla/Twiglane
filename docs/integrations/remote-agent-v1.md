# Twiglane 远端 Git agent v1

登录账号通过既有 SSH 会话运行 `~/.local/share/twiglane/agent/v1/agent --stdio`。发行产物为 `remote-agent/agent`，依赖 POSIX、Python 3.8+ 标准库和系统 Git 2.23+。无参数也可启动。运行 `--version` 返回单行 `twiglane-agent/1`。每个进程独立持有一个打开的工作树和一个当前差异游标。

标准输入与输出均为 UTF-8 JSON Lines，一问一答。请求公共字段为整数 `v: 1`、标识符 `id`（1–80 个 ASCII 字母、数字、下划线或连字符）、`op`。成功响应为 `{v,id,ok:true,result}`，失败响应为 `{v,id,ok:false,error:{code,message}}`。每条请求最多 128 KiB，结果最多 4 MiB；超出文件列表上限时显式返回错误。客户端保存发出请求时的主机身份，并检查响应 ID 和当前选择。

| op | 请求其余字段 | result |
|---|---|---|
| hello | 无 | `{protocol:1,agent:"twiglane-agent/1",host}` |
| open | `path` 为远端工作树根绝对路径，选填 `baseline` 为完整 commit OID | 状态快照。打开失败清除旧工作树。 |
| status | `repo`，选填 `baseline` | 当前状态快照 |
| diff | `repo,generation,path,view`。view 为 `staged`、`unstaged` 或 `task`，task 须加 `baseline`。续读时带上相同上下文和 `cursor` | `{data,nextCursor}`。data 为最多 16 KiB 差异原始字节的 Base64，nextCursor 为一次性字符串或 null；按顺序拼接并增量解码。 |
| stage、unstage | `repo,generation,operationId,paths`，paths 为已选相对路径数组 | 写入回执 |
| commit | `repo,generation,operationId,message` | 写入回执 |
| receipt | `repo,operationId` | 写入回执或 `{state:"unknown",operationId,repo,reason:"not_recorded"}` |

状态快照包含 `repo,root,host,head,branch,generation,files`。repo、generation 是不透明字符串，head、branch 可为 null（空仓库、分离 HEAD）。files 为 `{path,xy}` 数组，xy 是双字符 Git porcelain v1 状态（含空格），关闭重命名检测以相对路径区分增加与删除。给出可用基线时另外返回 `reviewFiles`，包含基线到工作树的变化及未跟踪文件。获取状态无需读取其他文件的差异。

operationId 为小写规范 UUID。发出写请求前持久记录所选 Cliora 主机身份、远端规范路径、repo、operationId 和请求摘要。相同 UUID 仅能匹配相同请求。成功的回执包含 `state:"completed",op,operationId,repo,beforeHead,branch,head,generation`。断线后重新打开原仓库、比对身份并查询 receipt，核实后刷新 status。缺记录、证据冲突或执行期间崩溃返回 unknown，界面保持待确认。断线或写入已登记后的失败都不能作为新发一次提交的依据。Git 凭据、终端和任意命令均不属于此协议。

读取新文件时从无 cursor 的 diff 开始，并废弃旧文件后续请求。每次只请求一页。客户端可在同一通道中提前发送新选中文件的首个 diff，让 agent 中止仍在生成的旧差异。旧请求可能以 superseded 结束，客户端按响应 ID 丢弃迟到结果。续页复用同一 Git 输出流，并核对文件、索引及 HEAD。游标只在原进程和原工作树快照有效。目标变更、generation 过期、游标过期、基线无效、Git 失败均返回可区分的错误。持久写入记录位于登录用户的 XDG_STATE_HOME（缺省 ~/.local/state）下，与仓库、工作树身份及操作 ID 关联。
