# metro-lang —— 代码编写要求与提交要求

本文件是 ParseEngine 仓库 [`AGENTS.md`](https://gitee.com/rabbitc999/ParseEngine) 的副本，
按 metro-lang 自己的路径、命令与远端改写了其中仓库相关的地方；通用规则（文法、注释、提交）
两份保持一致。

本文件只写**通用的代码编写要求与提交要求**；具体功能的设计与实现进度以代码、文档和
回归测试为准。

硬性要求：
1. **必须写完整的文法文件**：`metrolang.gram` 是 MetroLang 的**权威语法定义**，产生式要
   覆盖完整语法结构（文档 / 块 / 语句 / 参数 / 列表 / 嵌套），关键字用
   `%token NAME "字面量"` **逐个登记**，标点/字符串/数字/标识符各走
   `%token` / `%token regex` / `%identifier`，注释走 `%trivia`，空白走 `%space`；
   语义动作（`$$` / `$n`）只调用 `%code` 里的语义层。
2. **`.gram` 不能当"词法的提取器"**：禁止用一个大 `KW` / 一个万能 Token / 一条
   "任意 token 流"的产生式把整门语言糊过去，也禁止把每个关键字只当成待提取的词素
   堆进正则——那种写法等于没有文法，评审一律退回。关键字、块、命令都要能在产生式
   里被点名与组合。
3. **解析流程放进解析器生成器**：块栈、逐行折叠、驱动 `Parser::Engine::runText`
   的流程用 `%code` / `%epilogue include` 内嵌进生成产物，`src/` 里不再手写解析驱动。
   分析器源码（`build/metro-lang/gen/parser.cpp` 一带）是 `sh gen.sh` / `make gen`
   的生成物，落在 `build/`（已 gitignore）；`Makefile` / `gen.sh` 是手写的，`gen.sh`
   给生成器传 `--no-build-files` 不会覆盖它们。
4. **引用仓库三个库**（各自拷一份进本项目）：`preprocess/`（`%IF`/`%INCLUDE`/`%IMPORT`，
   用 `forMetro()`）、`template/`（反编译**模板化生成**，模板放 `template/templates/*.tmpl`）、
   `json/`（模型 ↔ JSON，对齐 [`doc/02-json-format.md`](doc/02-json-format.md)）。三份都是
   ParseEngine 的 `library/` 同名目录的**副本**，改了这边不会自动同步到 `library/`
   （反之亦然）——动其中一个时想清楚要不要一起改。本项目要能单独克隆、单独构建，
   **不依赖 `library/`**。
5. **固化模板代码**：`template/templates/` 的模板在构建期**内嵌成 C++ 源**
   （由 [`tools/embed_templates.py`](tools/embed_templates.py) 生成
   `build/metro-lang/gen/metro_templates.hpp`），运行时不读磁盘模板，保证单文件可用。
6. **完整文档注释**：头文件与 `.cpp` 的公开类型/函数都要中文 doc comment
   （`@brief` / `@param` / `@return`），沿用仓库风格。
7. 反编译用模板化生成；区间/等待/总时间按 [`doc/03-travel-time-model.md`](doc/03-travel-time-model.md)
   的模型。
8. `doc/README.md` 挂索引；最后 `git add -A` → commit → `git push origin master`
   （远端 <https://gitee.com/rabbitc999/metro-lang.git>）。

## 生成器（ParseEngine）是外部依赖

本仓库**只含 `.gram`，不含文法生成器**。生成器由 ParseEngine 仓库产出；`gen.sh` /
`make` / `ci.sh` 会按项目根目录 → 旁边的 ParseEngine 仓库 `build/bin/` 的顺序自动找它，
也可用 `ENGINE=<路径>` / `make PARSER=<路径>` 显式指定。生成器取不到的报错文案与
候选顺序三处保持一致。

## Git 提交信息（全仓库强制约束）

Git 提交身份按以下条件强制规范，适用于新建、补写、amend 及历史重写提交：

- 分别检查作者（author）与提交者（committer）的身份名称。名称同时包含“小兔”和“糖糖”时，
  该身份的名称必须统一为 **`小兔糖糖OvO`**，邮箱必须同时统一为 **`rabbitc999@outlook.com`**。
- 不满足上述条件的身份保留其真实名称和邮箱，不得批量覆盖其他贡献者或平台提交者的身份。
  这里的“名称”指 Git 作者／提交者名称；提交标题仍遵守下方的中文要求。
- 当前工作身份满足上述条件，仓库本地配置使用 `git config --local user.name "小兔糖糖OvO"`
  和 `git config --local user.email "rabbitc999@outlook.com"`。提交前用
  `git var GIT_AUTHOR_IDENT`、`git var GIT_COMMITTER_IDENT` 核对实际身份，避免环境变量
  或其他配置导致名称、邮箱不符合要求。

本仓库所有 Git 提交的标题及正文（如有）**必须使用中文**，禁止使用纯英文提交说明。
文件名、命令、API 标识符和必要的技术术语可以保留原文，但改动说明必须用中文表达。
此约束适用于本仓库的所有修改。
