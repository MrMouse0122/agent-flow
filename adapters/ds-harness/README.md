# @agent-flow/adapter-ds-harness（待调研接入）

DeepSeek Harness 是插件化框架（模型 / 工具 / 会话 / 循环 / UI 层皆可插件扩展），
因此首选接入姿势是做它的 **telemetry 插件**：在工具调用与会话事件回调里，
把信号翻译成 AgentEvent POST 给 AgentFlow server（参考 adapters/zcode 的做法）。

## 需要核实的三个问题

1. 插件 API 的入口与注册方式（钩子点：工具调用前后 / 会话开始结束 / 轮次结束）
2. 会话日志的落盘路径与格式（若存在，可先走 `@agent-flow/adapter-generic` 快速兜底）
3. 事件粒度：能否拿到 tool name / input / 涉及文件（决定依赖边推断质量）

在拿到真实环境验证前，本包保持 `research-needed` 占位状态，不假装能用。
