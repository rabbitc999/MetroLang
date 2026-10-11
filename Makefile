# metro-lang —— MetroLang 工具链（手写、纳入版本管理，不由 ParseEngine 覆盖）
#
# 与同目录的 `gen.sh` 分工：
#   * `gen.sh` 只重新生成解析器源码（`build/gen/parser.cpp` 一带），它给 ParseEngine
#     传 `--no-build-files`，所以不会覆盖这份 Makefile；
#   * 这份 Makefile 负责「生成代码 → 固化模板 → 编译」：
#       make gen   用 ParseEngine 从 `metrolang.gram` 重新生成分析器与模板头
#       make       编译出 `build/metro-lang`
#     生成与构建也可以分开：先 `make gen`，再 `make`。
#
# 目标：
#   make        默认生成分析器 + 固化模板 + 编译出 build/metro-lang
#   make gen    只重新生成分析器与模板头
#   make check  样例冒烟：编译 → JSON → 反编译 → HTML → 路线
#   make svg    把深圳样例导出成 doc/shenzhen-metro.svg（README 用图）
#   make preview 把 map_view 查看器的渲染结果导成 map_view/preview.svg
#   make clean  清掉本工程的构建产物
#
# 覆盖变量示例：
#   make CXX=clang++ CXXFLAGS="-std=c++17 -O0 -g"
#   make PARSER=/path/to/ParseEngine.exe   # 显式指定文法生成器
.DEFAULT_GOAL := all

# 独立 make 时也检测可用的 Python 3；构建入口可通过 PYTHON 传入检测结果。
ifeq ($(OS),Windows_NT)
PYTHON_NULL := NUL
else
PYTHON_NULL := /dev/null
endif
PYTHON ?= $(or $(shell python3 -c "import sys; print('python3' if sys.version_info.major == 3 else '')" 2>$(PYTHON_NULL)), \
              $(shell python -c "import sys; print('python' if sys.version_info.major == 3 else '')" 2>$(PYTHON_NULL)))
PYTHON := $(PYTHON)
ifeq ($(strip $(PYTHON)),)
$(error 找不到可用的 Python 3，请安装 python3 或 python，或设置 PYTHON)
endif

CXX      ?= g++
CXXFLAGS ?= -std=c++17 -O2 -Wall -Wextra -Wno-unused-parameter -MMD -MP

# 产物全部落在本仓库的 build/ 里，源码目录保持干净。
# 注意顺序：INCS 用 `:=` 立即展开，所以 BUILD/GEN 必须定义在 INCS 之前。
BUILD   := $(CURDIR)/build/metro-lang
GEN     := $(BUILD)/gen
BIN     := $(BUILD)/metro-lang

INCS     := -I$(CURDIR) -I$(CURDIR)/include -I$(CURDIR)/preprocess -I$(CURDIR)/template -I$(CURDIR)/json -I$(GEN)

# 文法生成器（ParseEngine）是**外部依赖**：本项目只有 .gram。按下面的顺序找，
# 也可用 PARSER=<路径> 指定（gen.sh 用的是同一套候选顺序，两边保持一致）：
#   ./ParseEngine[.exe]                        本项目根目录（最省事）
#   ../ParseEngine/build/bin/ParseEngine[.exe]  与 ParseEngine 仓库并排时
#   ../build/bin/ParseEngine[.exe]              还住在 ParseEngine 仓库里时
ifeq ($(origin PARSER),undefined)
PARSER := $(firstword $(wildcard $(CURDIR)/ParseEngine.exe) $(wildcard $(CURDIR)/ParseEngine) \
                        $(wildcard $(CURDIR)/../ParseEngine/build/bin/ParseEngine.exe) $(wildcard $(CURDIR)/../ParseEngine/build/bin/ParseEngine) \
                        $(wildcard $(CURDIR)/../build/bin/ParseEngine.exe) $(wildcard $(CURDIR)/../build/bin/ParseEngine))
endif

OBJS := \
	$(BUILD)/obj/src/model.o \
	$(BUILD)/obj/src/compile.o \
	$(BUILD)/obj/src/json.o \
	$(BUILD)/obj/src/decompile.o \
	$(BUILD)/obj/src/html.o \
	$(BUILD)/obj/src/route.o \
	$(BUILD)/obj/src/main.o \
	$(BUILD)/obj/preprocess/preprocess.o \
	$(BUILD)/obj/json/json.o \
	$(BUILD)/obj/gen/parser.o

TMPL_SRC := $(wildcard $(CURDIR)/template/templates/*.tmpl)

# 头文件依赖：改 metro_model.hpp / metro_semantics.hpp 这类公共头时，
# 所有包含它的目标文件都要重编，否则结构体布局会在不同 .o 之间不一致。
DEPS := $(OBJS:.o=.d)
-include $(DEPS)

.PHONY: all gen check clean svg preview

# 生成产物随源码一起清掉，避免残留旧分析器 / 旧模板头。
all: $(BIN)

$(GEN)/metro_templates.hpp: $(TMPL_SRC) $(CURDIR)/tools/embed_templates.py
	@mkdir -p $(GEN)
	$(PYTHON) $(CURDIR)/tools/embed_templates.py --out $@ $(TMPL_SRC)

# 下面这条自检的提示语只能写 ASCII：Windows 上的 mingw32-make 构造命令行时会把
# 参数按 ANSI(CP936) 转一遍，中文消息里奇数个字节会把紧邻的转义引号吃掉，整条
# 命令被拆成几段，报 `unexpected EOF while looking for matching '"'`。
# 中文含义：ParseEngine 生成失败，请看上面的错误（旧 parser.cpp 已删除，绝不静默用旧产物）。
$(GEN)/parser.cpp: $(CURDIR)/metrolang.gram $(CURDIR)/epilogue/metro_parse.cpp $(PARSER)
	@mkdir -p $(GEN)
	@rm -f $(GEN)/parser.cpp
	$(PARSER) $(CURDIR)/metrolang.gram --lang cpp17 --out-dir $(GEN)
	@test -s $(GEN)/parser.cpp || { echo "ParseEngine generation failed - see errors above (old parser.cpp removed)"; exit 1; }

gen: $(GEN)/parser.cpp $(GEN)/metro_templates.hpp

$(BUILD)/obj/src/%.o: $(CURDIR)/src/%.cpp
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) $(INCS) -c $< -o $@

$(BUILD)/obj/preprocess/%.o: $(CURDIR)/preprocess/%.cpp
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) $(INCS) -c $< -o $@

$(BUILD)/obj/json/%.o: $(CURDIR)/json/%.cpp
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) $(INCS) -c $< -o $@

$(BUILD)/obj/gen/%.o: $(GEN)/%.cpp
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) $(INCS) -c $< -o $@

$(BUILD)/obj/src/decompile.o: $(GEN)/metro_templates.hpp

$(BIN): $(OBJS)
	$(CXX) $(CXXFLAGS) $(OBJS) -o $@

# 把深圳样例渲染成独立 SVG（README 里的那张图），改了渲染逻辑就重跑它。
# 默认不打印站名（--no-labels）：354 座站的站名在小图里会糊成一片；--scale 2
# 把内联尺寸放大到 3200×2400，矢量图放大不掉清晰度，方便放大查看 / 印刷。
svg: $(BIN)
	$(PYTHON) $(CURDIR)/tools/export_svg.py --bin $(BIN) --sample $(CURDIR)/samples/shenzhen.m \
		--out $(CURDIR)/doc/shenzhen-metro.svg --title 深圳地铁线网 --no-labels --scale 2

# 查看器效果图（map_view/preview.svg）：先编出深圳 JSON，再交给无头渲染脚本。
# 依赖 node + jsdom、python 的 cairosvg、ImageMagick 的 convert；缺了会直接报错。
preview: $(BUILD)/shenzhen.json
	$(PYTHON) $(CURDIR)/map_view/tools/make_preview.py $(BUILD)/shenzhen.json \
		$(CURDIR)/map_view/preview.svg

$(BUILD)/shenzhen.json: $(BIN) $(CURDIR)/samples/shenzhen.m
	$(BIN) compile $(CURDIR)/samples/shenzhen.m -o $@

# Windows 上 make 找不到 sh：优先用 Git Bash / MSYS2 的 bash（与其它独立工程一致）。
ifeq ($(OS),Windows_NT)
  SH ?= $(firstword $(wildcard C:/PROGRA~1/Git/bin/bash.exe) \
                    $(wildcard C:/PROGRA~2/Git/bin/bash.exe) \
                    $(wildcard C:/msys64/usr/bin/bash.exe) sh)
else
  SH ?= sh
endif

check: $(BIN)
	$(SH) $(CURDIR)/check.sh

clean:
	@rm -rf $(BUILD)
	@echo 已清理 $(BUILD)
