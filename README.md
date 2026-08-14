# Skills

记录我编写的 Skill。

## 什么是 Skill

Skill 是给 AI Agent 使用的专项能力包：用自然语言描述某类任务的工作流、约束和参考资料，Agent 在遇到匹配场景时按需加载。

## 目录结构

每个 Skill 一个目录，目录名即 Skill 名（小写连字符）：

```
<skill-name>/
├── SKILL.md        # 必需：元信息 + 工作流说明
├── scripts/        # 可选：辅助脚本
└── references/     # 可选：参考文档
```

`SKILL.md` 以 YAML frontmatter 开头：

```markdown
---
name: skill-name
description: 这个 Skill 做什么，以及什么时候该用它
---

# Skill Name

具体的工作流说明……
```

## Skill 列表

| Skill | 说明 |
| --- | --- |
| _待补充_ | |

## 编写要点

- `description` 决定 Skill 能否被正确触发，需写明**适用场景**和**不适用场景**。
- 正文面向 Agent 而非人类读者，给明确的步骤和判断条件。
- 单个 Skill 只解决一类问题，边界重叠时拆分。
