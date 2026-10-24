# 安全策略

Pulse 的 Agent 运行在生产机器上，并能执行服务器下发的指令，我们非常重视安全问题。

## 报告漏洞

请**不要**公开提 Issue。通过 GitHub 的 [Private vulnerability reporting](https://github.com/imythu/pulse/security/advisories/new) 私下报告，包含影响版本、复现步骤和影响范围。我们会在 7 天内回复。

## 重点范围

- 绕过指令签名、重放、主机绑定或本机 `commands.allow` 限制；
- 通过指令参数实现任意命令执行或越权读取文件（路径穿越、符号链接）；
- Agent 身份伪造、注册令牌滥用；
- 控制台鉴权与角色（viewer / operator / admin）绕过；
- 日志脱敏遗漏导致的敏感信息上报。

## 支持的版本

目前只修复最新版本。
