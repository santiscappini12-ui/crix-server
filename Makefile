# CRIX ENGINE — Makefile
# Requiere Emscripten instalado: https://emscripten.org/docs/getting_started/downloads.html
#
# USO:
#   make        → compila el motor en ../public/crix_engine.js + crix_engine.wasm
#   make clean  → limpia archivos compilados

CC = emcc
SRC = src/engine.cpp
OUT = ../public/crix_engine.js

CFLAGS = \
  -O2 \
  -std=c++17 \
  -s WASM=1 \
  -s USE_WEBGL2=1 \
  -s FULL_ES3=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s MODULARIZE=1 \
  -s EXPORT_NAME="CrixEngine" \
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","UTF8ToString"]' \
  -s EXPORTED_FUNCTIONS='[ \
    "_crix_init", \
    "_crix_frame", \
    "_crix_input", \
    "_crix_resize", \
    "_crix_add_part", \
    "_crix_remove_part", \
    "_crix_clear_parts", \
    "_crix_select_part", \
    "_crix_set_lighting", \
    "_crix_set_player_color", \
    "_crix_set_player_pos", \
    "_crix_set_mode", \
    "_crix_cam_scroll", \
    "_crix_get_player_state", \
    "_crix_is_ready" \
  ]' \
  -s NO_EXIT_RUNTIME=1

all: $(OUT)

$(OUT): $(SRC)
	@mkdir -p ../public
	$(CC) $(SRC) $(CFLAGS) -o $(OUT)
	@echo "✅ Motor compilado → $(OUT)"

clean:
	rm -f $(OUT) $(patsubst %.js,%.wasm,$(OUT))

.PHONY: all clean
