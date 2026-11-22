// Math in Markdown: \( … \), \[ … \], $$ … $$ and $ … $ (Pandoc's rules, so prices like "$5 and $10"
// stay text). Markdown would otherwise read "\(" and "\[" as escaped brackets and drop the backslash,
// and treat "_" and "*" inside formulas as emphasis. Each formula becomes one node whose position
// covers its whole source, delimiters included, so selections and annotations map back exactly.

const BACKSLASH = 92;
const DOLLAR = 36;
const isLineEnding = (code) => code !== null && code < -2;
const isSpace = (code) => code === null || code < 0 || code === 32;
const isDigit = (code) => code >= 48 && code <= 57;

// Consume one character, giving line endings their own token as micromark expects.
function step(effects, code, chunk) {
  if (isLineEnding(code)) {
    effects.exit(chunk);
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    effects.enter(chunk);
  } else {
    effects.consume(code);
  }
}

// \( … \) inline, \[ … \] display, inside a paragraph (may span its lines).
const backslashText = {
  name: "backslashMath",
  add: "before",
  tokenize(effects, ok, nok) {
    let close;
    let size = 0;
    return (code) => {
      effects.enter("mathInline");
      effects.enter("mathChunk");
      effects.consume(code);
      return open;
    };
    function open(code) {
      if (code !== 40 && code !== 91) return nok(code);
      close = code === 40 ? 41 : 93;
      effects.consume(code);
      return inside;
    }
    function inside(code) {
      if (code === null) return nok(code);
      if (code === BACKSLASH) {
        effects.consume(code);
        return escaped;
      }
      size += 1;
      step(effects, code, "mathChunk");
      return inside;
    }
    // "\)" closes; any other "\x" (\\, \frac, \{ …) is part of the formula.
    function escaped(code) {
      if (code === null) return nok(code);
      if (code === close) {
        if (!size) return nok(code);
        effects.consume(code);
        effects.exit("mathChunk");
        effects.exit("mathInline");
        return ok;
      }
      size += 1;
      step(effects, code, "mathChunk");
      return inside;
    }
  }
};

// $$ … $$ display, or $ … $ inline when it looks like math: the opening $ is followed by a
// non-space, the closing $ follows a non-space and is not followed by a digit.
const dollarText = {
  name: "dollarMath",
  tokenize(effects, ok, nok) {
    let double = false;
    let size = 0;
    let previous;
    return (code) => {
      effects.enter("mathInline");
      effects.enter("mathChunk");
      effects.consume(code);
      return afterFirst;
    };
    function afterFirst(code) {
      if (code === DOLLAR) {
        double = true;
        effects.consume(code);
        return inside;
      }
      if (isSpace(code)) return nok(code);
      return inside(code);
    }
    function inside(code) {
      if (code === null) return nok(code);
      if (code === BACKSLASH) {
        effects.consume(code);
        previous = code;
        return escaped;
      }
      if (code === DOLLAR) {
        if (double) {
          effects.consume(code);
          return secondClose;
        }
        if (size && !isSpace(previous)) {
          effects.consume(code);
          return closeCheck;
        }
      }
      size += 1;
      previous = code;
      step(effects, code, "mathChunk");
      return inside;
    }
    function escaped(code) {
      if (code === null) return nok(code);
      size += 1;
      previous = code;
      step(effects, code, "mathChunk");
      return inside;
    }
    function secondClose(code) {
      if (code !== DOLLAR || !size) {
        // A lone "$" inside $$ … $$ is part of the formula.
        size += 1;
        previous = DOLLAR;
        return inside(code);
      }
      effects.consume(code);
      return done;
    }
    // "$5 and $10": the second "$" is followed by a digit, so it does not close.
    function closeCheck(code) {
      if (isDigit(code)) {
        size += 1;
        previous = DOLLAR;
        return inside(code);
      }
      return done(code);
    }
    function done(code) {
      effects.exit("mathChunk");
      effects.exit("mathInline");
      return ok(code);
    }
  }
};

// A formula on lines of its own: "\[" or "$$" opening a line, closed by "\]" or "$$" ending a later
// line. Blank lines and lines that would otherwise start lists or headings stay inside.
function flowMath(opener, closer) {
  return {
    name: `mathFlow${opener}`,
    concrete: true,
    tokenize(effects, ok, nok) {
      let matched = 0;
      let line = "";
      let firstLine = true;
      return (code) => {
        effects.enter("mathBlock");
        effects.enter("mathChunk");
        return openMarker(code);
      };
      function openMarker(code) {
        if (code !== opener.charCodeAt(matched)) return nok(code);
        effects.consume(code);
        matched += 1;
        return matched === opener.length ? rest : openMarker;
      }
      function rest(code) {
        if (code === null) return nok(code);
        if (isLineEnding(code)) {
          // "\[ x \]" or "$$x$$" on one line is left to the inline rule.
          if (firstLine && line.trimEnd().endsWith(closer) && line.trim().length > closer.length) return nok(code);
          firstLine = false;
          line = "";
          step(effects, code, "mathChunk");
          return rest;
        }
        line += code < 0 ? " " : String.fromCharCode(code);
        effects.consume(code);
        if (!firstLine && line.trimEnd().endsWith(closer)) return closeLine;
        if (firstLine && line.trim().length > closer.length && line.trimEnd().endsWith(closer)) return nok;
        return rest;
      }
      // The closing marker must end its line (spaces may follow).
      function closeLine(code) {
        if (code === null || isLineEnding(code)) {
          effects.exit("mathChunk");
          effects.exit("mathBlock");
          return ok(code);
        }
        return rest(code);
      }
    }
  };
}

export const mathSyntax = {
  text: { [BACKSLASH]: backslashText, [DOLLAR]: dollarText },
  flow: { [BACKSLASH]: flowMath("\\[", "\\]"), [DOLLAR]: flowMath("$$", "$$") }
};

// The formula without its delimiters, and whether it is set apart.
export function mathParts(raw) {
  const text = raw.trim();
  for (const [open, close, display] of [["\\[", "\\]", true], ["$$", "$$", true], ["\\(", "\\)", false], ["$", "$", false]]) {
    if (text.startsWith(open) && text.endsWith(close) && text.length >= open.length + close.length) {
      return { value: text.slice(open.length, text.length - close.length).trim(), display };
    }
  }
  return { value: text, display: false };
}

export const mathFromMarkdown = {
  enter: {
    mathInline(token) { this.enter({ type: "inlineMath", value: "", display: false }, token); },
    mathBlock(token) { this.enter({ type: "math", value: "", display: true }, token); }
  },
  exit: {
    mathInline(token) {
      const node = this.stack.at(-1);
      Object.assign(node, mathParts(this.sliceSerialize(token)));
      this.exit(token);
    },
    mathBlock(token) {
      const node = this.stack.at(-1);
      node.value = mathParts(this.sliceSerialize(token)).value;
      this.exit(token);
    }
  }
};
