"use strict";

const glyphCaches = new WeakMap();
const DEFAULT_FONT = "minecraft:default";
const PADDING = 3;

function textRuns(text, style = {}) {
  text = [...String(text ?? "")].slice(0, 1024).join("");
  const source = Array.isArray(style.runs) && style.runs.length <= 64 && style.runs.every(run => typeof run?.text === "string") && style.runs.map(run => run.text).join("") === text ? style.runs : [{ text }];
  return source.map(run => ({
    text:run.text, color:Number.isInteger(run.color) ? run.color & 0xffffff : 0xffffff,
    font:typeof run.font === "string" ? run.font : DEFAULT_FONT,
    bold:run.bold === true, italic:run.italic === true, underlined:run.underlined === true,
    strikethrough:run.strikethrough === true, obfuscated:run.obfuscated === true,
  }));
}

function layoutText(cells, lineWidth = 200, alignment = "CENTER") {
  const maximum = Math.max(1, Math.min(4096, Number(lineWidth) || 200));
  const lines = [];
  let line = [], width = 0;
  const append = value => lines.push({ cells:value, width:value.reduce((sum, cell) => sum + cell.advance, 0) });
  for (const cell of cells) {
    if (lines.length >= 32) break;
    if (cell.character === "\n") { append(line); line = []; width = 0; continue; }
    line.push(cell); width += cell.advance;
    if (width > maximum && line.length > 1) {
      let space = -1;
      for (let index = 0; index < line.length; index++) if (line[index].character === " ") space = index;
      const split = space >= 0 ? space : line.length - 1;
      append(line.slice(0, split));
      line = line.slice(split + (space >= 0 ? 1 : 0));
      width = line.reduce((sum, cell) => sum + cell.advance, 0);
    }
  }
  if (lines.length < 32 && (line.length || cells.length && cells.at(-1).character === "\n")) append(line);
  const widest = Math.max(0, ...lines.map(line => line.width));
  for (const line of lines) line.x = alignment === "LEFT" ? 0 : alignment === "RIGHT" ? widest - line.width : (widest - line.width) / 2;
  // TextDisplayRenderer uses font lineHeight(9)+1 and subtracts one from its
  // text height; the background spans [-1,width] × [-1,height].
  return { lines, width:widest, height:lines.length * 10 };
}

async function glyph(font, character, loadImage, createCanvas) {
  let cache = glyphCaches.get(font);
  if (!cache) { cache = new Map(); glyphCaches.set(font, cache); }
  if (!cache.has(character)) cache.set(character, (async () => {
    const definition = font.glyphs[character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")];
    if (!definition || character === " ") return { advance:4 };
    const image = await loadImage(definition.url), width = image.width / definition.columns, height = image.height / definition.rows;
    const canvas = createCanvas(width, height), context = canvas.getContext("2d");
    context.drawImage(image, definition.column * width, definition.row * height, width, height, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height);
    let ink = 0;
    for (let x = 0; x < width; x++) for (let y = 0; y < height; y++) if (pixels.data[(y * width + x) * 4 + 3]) ink = Math.max(ink, x + 1);
    return { pixels, width:width * definition.height / height, height:definition.height, ascent:definition.ascent, advance:Math.floor(ink * definition.height / height + .5) + 1 };
  })());
  return cache.get(character);
}

async function renderTextDisplay(text, style, font, loadImage, createCanvas) {
  style ??= {};
  const runs = textRuns(text, style), cells = [], unsupportedFonts = new Set();
  for (const run of runs) {
    const selectedFont = font.fonts?.[run.font] ?? font;
    if (run.font !== DEFAULT_FONT && !font.fonts?.[run.font]) unsupportedFonts.add(run.font);
    for (const character of run.text) {
      const image = character === "\n" ? { advance:0 } : await glyph(selectedFont, character, loadImage, createCanvas);
      cells.push({ character, style:run, image, advance:image.advance + (run.bold && character !== "\n" ? 1 : 0) });
    }
  }
  const layout = layoutText(cells, style.lineWidth, style.alignment);
  if (!layout.lines.length) return null;
  const canvas = createCanvas(layout.width + 1 + PADDING * 2, layout.height + PADDING * 2), context = canvas.getContext("2d");
  context.imageSmoothingEnabled = false;
  const background = (style.defaultBackground ? 0x3f000000 : style.backgroundColor ?? 0x40000000) >>> 0;
  context.fillStyle = `rgba(${background >>> 16 & 255},${background >>> 8 & 255},${background & 255},${(background >>> 24) / 255})`;
  // The native text and background fragment shaders both discard alpha < .1.
  if ((background >>> 24) >= 25.5) context.fillRect(PADDING, PADDING, layout.width + 1, layout.height);
  const opacity = Math.max(0, Math.min(255, Number(style.opacity ?? 255)));
  const tinted = new Map();
  function image(cell, shadow) {
    const color = shadow ? (cell.style.color & 0xfcfcfc) >>> 2 : cell.style.color;
    const key = `${cell.style.font}|${cell.character}|${color}`;
    if (!tinted.has(key)) {
      const source = cell.image.pixels, canvas = createCanvas(source.width, source.height), target = canvas.getContext("2d"), pixels = target.createImageData(source.width, source.height);
      for (let index = 0; index < source.data.length; index += 4) {
        const alpha = source.data[index + 3] * opacity / 255;
        if (alpha < 25.5) continue;
        pixels.data[index] = source.data[index] * (color >>> 16 & 255) / 255;
        pixels.data[index + 1] = source.data[index + 1] * (color >>> 8 & 255) / 255;
        pixels.data[index + 2] = source.data[index + 2] * (color & 255) / 255;
        pixels.data[index + 3] = alpha;
      }
      target.putImageData(pixels, 0, 0); tinted.set(key, canvas);
    }
    return tinted.get(key);
  }
  function draw(shadow) {
    if (opacity < 25.5) return;
    const offset = shadow ? 1 : 0;
    layout.lines.forEach((line, index) => {
      let x = PADDING + 1 + line.x + offset;
      const y = PADDING + 1 + index * 10 + offset;
      for (const [cellIndex, cell] of line.cells.entries()) {
        if (cell.image.pixels) {
          const top = 7 - cell.image.ascent;
          context.save();
          context.translate(x + (cell.style.italic ? 1 - top / 4 : 0), y + top);
          if (cell.style.italic) context.transform(1, 0, -.25, 1, 0, 0);
          context.drawImage(image(cell, shadow), 0, 0, cell.image.width, cell.image.height);
          if (cell.style.bold) context.drawImage(image(cell, shadow), 1, 0, cell.image.width, cell.image.height);
          context.restore();
        }
        const color = shadow ? (cell.style.color & 0xfcfcfc) >>> 2 : cell.style.color;
        context.fillStyle = `rgba(${color >>> 16 & 255},${color >>> 8 & 255},${color & 255},${opacity / 255})`;
        const leading = cellIndex === 0 ? 1 : 0;
        if (cell.style.underlined) context.fillRect(x - leading, y + 8, cell.advance + leading, 1);
        if (cell.style.strikethrough) context.fillRect(x - leading, y + 3.5, cell.advance + leading, 1);
        x += cell.advance;
      }
    });
  }
  if (style.shadow) draw(true);
  draw(false);
  return { canvas, width:canvas.width * .025, height:canvas.height * .025,
    x:.0125, y:layout.height * .0125, seeThrough:style.seeThrough === true,
    unsupportedFonts:[...unsupportedFonts] };
}

module.exports = { textRuns, layoutText, renderTextDisplay };
