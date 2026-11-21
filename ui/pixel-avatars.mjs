const designs = {
  human: {
    label: "像素旅人",
    palette: { h: "#44344d", s: "#f4bd93", e: "#302f44", r: "#e38a86", t: "#72aa92", o: "#426f67" },
    pixels: [
      "...hhhhhh...", "..hhhhhhhh..", "..hssssssh..", "..ssssssss..",
      "..sseesess..", "..ssrssrss..", "...ssssss...", "...hssss h...",
      "..otttttto..", ".oottttttoo.", ".otttttttto.", "..oo....oo.."
    ]
  },
  robot: {
    label: "像素机器人",
    palette: { a: "#f4d982", b: "#364d79", c: "#8ed6d7", e: "#263d65", d: "#f8fbdf", f: "#7e92c4" },
    pixels: [
      ".....a......", "....aaa.....", "..bbbbbbbb..", ".bccccccccb.",
      ".bcceeccecb.", ".bccccccccb.", ".bccddddccb.", ".bccccccccb.",
      "..bbbbbbbb..", "...bffffb...", "..bbffffbb..", "..b......b.."
    ]
  },
  fox: {
    label: "像素小狐",
    palette: { o: "#a9544d", f: "#e9915f", c: "#fff0cd", e: "#3d3546", r: "#dd6e6b", s: "#667da3" },
    pixels: [
      "..oo....oo..", "..off..ffo..", "..offffffo..", ".offffffffo.",
      ".offeffeffo.", ".offfccfffo.", "..offccffo..", "...offffo...",
      "...rrrrrr...", "..ssrrrrss..", ".sssrrrrsss.", "..ss....ss.."
    ]
  },
  cat: {
    label: "像素小猫",
    palette: { o: "#514868", c: "#b6a9cb", e: "#35314c", n: "#ed9aaf", w: "#f7ecdc", s: "#8e84b4" },
    pixels: [
      "..oo....oo..", "..occ..cco..", ".occccccco..", ".occcccccco.",
      ".occeecceco.", ".occcnnccco.", ".owccwwccwo.", "..occcccco..",
      "...ssssss...", "..ssssssss..", "..ss....ss..", "..oo....oo.."
    ]
  },
  owl: {
    label: "像素猫头鹰",
    palette: { o: "#6b4a2f", b: "#a77b4f", w: "#f6ead2", e: "#2c2a3a", k: "#f2b84b", f: "#d8c19a" },
    pixels: [
      ".o........o.", ".oo......oo.", ".obbbbbbbbo.", "obwwwbbwwwbo",
      "obwewbbwewbo", "obwwwkkwwwbo", ".obbbkkbbbo.", ".obffffffbo.",
      ".obffffffbo.", "..obffffbo..", "...obbbbo...", "...kk..kk..."
    ]
  },
  frog: {
    label: "像素小蛙",
    palette: { g: "#4f9a5a", l: "#8fd18b", w: "#ffffff", e: "#25313a", m: "#2f6b3d", p: "#f29aa8" },
    pixels: [
      "..ww....ww..", ".wwew..weww.", ".gwwg..gwwg.", "gggggggggggg",
      "gllllllllllg", "glpllllllplg", "gllmmmmmmllg", ".gllllllllg.",
      "..gggggggg..", ".gl.gggg.lg.", ".gg......gg.", "gg........gg"
    ]
  },
  bear: {
    label: "像素小熊",
    palette: { b: "#7b5135", l: "#b98457", c: "#f0d2a8", e: "#2b2230", n: "#4a2f26", s: "#5f8fbf" },
    pixels: [
      ".bb......bb.", "bllb....bllb", ".bbbbbbbbbb.", ".bllllllllb.",
      ".blellllelb.", ".bllccccllb.", ".blccnncclb.", "..bcccccb...",
      "...ssssss...", "..ssssssss..", "..bb....bb..", "..bb....bb.."
    ]
  },
  bunny: {
    label: "像素兔子",
    palette: { w: "#f7f3f8", p: "#f3b6c8", g: "#c9c0d6", e: "#3a3046", n: "#e7809b", s: "#9fc7e8" },
    pixels: [
      "..ww....ww..", "..wp....pw..", "..wp....pw..", "..ww....ww..",
      ".wwwwwwwwww.", ".wweewweeww.", ".wwwwnnwwww.", ".wpwwwwwwpw.",
      "..gwwwwwwg..", "...ssssss...", "..ssssssss..", "..ww....ww.."
    ]
  }
};

export const avatarChoices = Object.entries(designs).map(([id, design]) => ({ id, label: design.label }));

function imageFor(kind) {
  const design = designs[kind] || designs.robot;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("aria-hidden", "true");
  for (const [y, line] of design.pixels.entries()) {
    for (const [x, pixel] of [...line.padEnd(12, ".").slice(0, 12)].entries()) {
      if (!design.palette[pixel]) continue;
      const cell = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      cell.setAttribute("x", String(x));
      cell.setAttribute("y", String(y));
      cell.setAttribute("width", "1");
      cell.setAttribute("height", "1");
      cell.setAttribute("fill", design.palette[pixel]);
      svg.append(cell);
    }
  }
  return svg;
}

export function pixelAvatar(kind, state = "idle", label = "头像") {
  const avatar = document.createElement("span");
  avatar.className = "pixel-avatar";
  avatar.dataset.avatar = designs[kind] ? kind : "robot";
  avatar.dataset.state = state;
  avatar.setAttribute("role", "img");
  avatar.setAttribute("aria-label", label);
  const image = imageFor(kind);
  const signal = document.createElement("span");
  signal.className = "avatar-signal";
  signal.setAttribute("aria-hidden", "true");
  avatar.append(image, signal);
  return avatar;
}
