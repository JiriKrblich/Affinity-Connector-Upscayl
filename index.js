// Upscayl — enlarging artwork with a program already on this machine.
//
// The point of this one is that nothing leaves the computer. Affinity exports
// the artwork, Upscayl's command line binary enlarges it, and the result goes
// back into the document. No account, no key, no network.
//
// Upscayl ships a GUI, but inside the bundle is the binary the GUI drives:
//
//   upscayl-bin -i in.png -o out.png -m <models folder> -n <model> -s <scale> -f png
//
// It is a build of realesrgan-ncnn-vulkan, so any compatible binary and model
// folder works if someone points the last field at it.

const path = require("node:path");
const fs = require("node:fs/promises");

// Where Upscayl installs itself on each platform. ctx.locate walks these in
// order, expands ~ and %VARIABLES%, and falls back to whatever is on PATH —
// which is how a Homebrew or Linux package build turns up.
const WHERE = {
  mac: [
    "/Applications/Upscayl.app/Contents/Resources/bin/upscayl-bin",
    "~/Applications/Upscayl.app/Contents/Resources/bin/upscayl-bin",
  ],
  windows: [
    "%LOCALAPPDATA%\\Programs\\Upscayl\\resources\\bin\\upscayl-bin.exe",
    "%PROGRAMFILES%\\Upscayl\\resources\\bin\\upscayl-bin.exe",
  ],
  linux: [
    "/opt/Upscayl/resources/bin/upscayl-bin",
    "/usr/share/upscayl/resources/bin/upscayl-bin",
    "~/.local/share/upscayl/resources/bin/upscayl-bin",
    "/var/lib/flatpak/app/org.upscayl.Upscayl/current/active/files/bin/upscayl-bin",
  ],
  command: "upscayl-bin",
};

// How big the artwork is, read from the file's own header. Upscayl multiplies
// this, and the answer decides whether the result can be written at all.
async function imageSize(file) {
  const handle = await fs.open(file, "r").catch(() => null);
  if (!handle) return null;
  try {
    const { buffer } = await handle.read(Buffer.alloc(64 * 1024), 0, 64 * 1024, 0);

    // PNG: the header sits at a fixed place.
    if (buffer.slice(1, 4).toString() === "PNG") {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }

    // JPEG: walk the segments to the one that carries the size.
    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
      let at = 2;
      while (at < buffer.length - 9) {
        if (buffer[at] !== 0xff) { at++; continue; }
        const marker = buffer[at + 1];
        const length = buffer.readUInt16BE(at + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buffer.readUInt16BE(at + 5), width: buffer.readUInt16BE(at + 7) };
        }
        at += 2 + length;
      }
    }

    // TIFF, which is what Affinity hands over for some presets.
    if (buffer.slice(0, 2).toString() === "II" || buffer.slice(0, 2).toString() === "MM") {
      return null;
    }
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

// WebP cannot hold a side longer than this, whatever the encoder is asked to
// do. Four times a large export goes past it easily, and the failure arrives as
// "Couldn't write the image", which sounds like a permissions problem.
const WEBP_LIMIT = 16383;

async function findBinary(ctx) {
  // Where Upscayl lives is set up once under Settings.
  const configured = String(ctx.settings.binary || ctx.input.binary || "").trim();
  if (configured) {
    const expanded = ctx.expandPath(configured);
    if (!(await fs.stat(expanded).catch(() => null))) {
      throw new Error(`Nothing at ${expanded}. Check the Upscayl command field.`);
    }
    return expanded;
  }

  const found = await ctx.locate(WHERE);
  if (found) {
    ctx.log(`Using Upscayl at ${found.path}${found.source === "path" ? " (from PATH)" : ""}`);
    return found.path;
  }

  const looked = (WHERE[ctx.platform.os] || []).map((p) => ctx.expandPath(p));
  throw new Error(
    `Could not find Upscayl on this ${ctx.platform.os === "mac" ? "Mac" : ctx.platform.os} machine. ` +
      `Looked in: ${looked.join(", ")}. Install it from upscayl.org, or put the path to upscayl-bin in the Upscayl command field.`,
  );
}

// The models are two files each, a .bin and a .param, and the name to pass is
// the one without an extension. Where that folder sits depends on how Upscayl
// was installed, so try the shapes that exist in the wild.
async function modelsFolderFor(binary) {
  const bin = path.dirname(binary);
  const candidates = [
    path.join(path.dirname(bin), "models"), // the app bundle layout
    path.join(bin, "models"), // beside the binary
    path.join(path.dirname(path.dirname(bin)), "models"), // a package install
    "/usr/share/upscayl/models",
  ];
  for (const folder of candidates) {
    const entries = await fs.readdir(folder).catch(() => null);
    if (entries && entries.some((f) => f.endsWith(".param"))) return folder;
  }
  return candidates[0];
}

async function listModels(binary) {
  const folder = await modelsFolderFor(binary);
  const entries = await fs.readdir(folder).catch(() => []);
  return [...new Set(entries.filter((f) => f.endsWith(".param")).map((f) => f.replace(/\.param$/, "")))].sort();
}

function prettyModelName(id) {
  return id
    .replace(/-(\d)x$/, " ×$1")
    .replace(/-/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

module.exports = {
  options: {
    // Reads what is actually installed rather than guessing, which matters
    // because people add their own models to that folder.
    async models(ctx) {
      const binary = await findBinary(ctx);
      const found = await listModels(binary);
      if (!found.length) {
        ctx.log.warn(`No models found near ${binary}`);
        return [];
      }
      return found.map((id) => ({ value: id, label: prettyModelName(id) }));
    },
  },

  async run(ctx) {
    const source = ctx.input.image;
    if (!source || !source.path) throw new Error("Choose what to enlarge first.");

    const binary = await findBinary(ctx);
    const models = await modelsFolderFor(binary);
    const model = String(ctx.input.model || "upscayl-standard-4x");
    const scale = String(ctx.input.scale || "4");
    const format = String(ctx.input.format || "png");

    const installed = await listModels(binary);
    if (installed.length && !installed.includes(model)) {
      throw new Error(
        `Your copy of Upscayl has no model called ${model}. It has: ${installed.join(", ")}`,
      );
    }

    // What the result will measure, before anything spends two minutes on it.
    const size = await imageSize(source.path);
    let writeAs = format;
    if (size) {
      const wide = size.width * Number(scale);
      const tall = size.height * Number(scale);
      ctx.log(`${size.width}×${size.height} in, ${wide}×${tall} out`);
      if (format === "webp" && Math.max(wide, tall) > WEBP_LIMIT) {
        writeAs = "png";
        ctx.log.warn(
          `WebP cannot hold anything longer than ${WEBP_LIMIT} pixels a side, so this one is written as PNG instead.`,
        );
      }
    }

    const output = ctx.files.inbox(`upscayled-${Date.now()}.${writeAs}`);
    ctx.log(`Enlarging ${Math.round(source.bytes / 1024)} KB from the ${source.source}`);
    ctx.progress(`Running ${prettyModelName(model)} at ${scale}×`);

    // Upscayl writes its progress to stderr and exits 0 on success. A GPU
    // enlargement of a large canvas takes a while, so this is where the run
    // timeout under Settings earns its keep.
    const result = await ctx.shell.run(binary, [
      "-i", source.path,
      "-o", output,
      "-m", models,
      "-n", model,
      "-s", scale,
      "-f", writeAs,
    ]);

    const note = String(result.stderr || result.stdout || "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^\d+(\.\d+)?$/.test(l))
      .slice(-3);
    for (const line of note) ctx.log(line);

    if (!(await ctx.files.exists(output))) {
      // Whatever the tool said last is nearly always the reason, so it goes in
      // the error rather than being left for someone to find in the log.
      const said = note.filter((line) => /error|cannot|couldn|fail/i.test(line)).slice(-1)[0] || note.slice(-1)[0];
      throw new Error(
        said
          ? `Upscayl finished without leaving a file. It said: ${said}`
          : "Upscayl finished without leaving a file, and said nothing about why.",
      );
    }

    let placed = null;
    if (ctx.input.place !== false) {
      if (ctx.input.__bridgeDirect === true) {
        // The helper waits synchronously, so the runner queues this placement
        // and the helper performs it after the HTTP call returns.
        ctx.progress("Placing it in the document");
        placed = await ctx.affinity.putBack(output, source);
      } else {
        const doc = await ctx.affinity.info();
        if (doc.open) {
          ctx.progress("Placing it in the document");
          // An enlargement belongs on top of what it enlarged.
          placed = await ctx.affinity.putBack(output, source);
        } else {
          ctx.log.warn("No document is open, so the result is waiting in the handover folder.");
        }
      }
    }

    return {
      message: placed
        ? placed.width && placed.height
          ? `Placed a ${placed.width}×${placed.height} enlargement`
          : `Placed a ${scale}× enlargement`
        : `Enlarged ${scale}× with ${prettyModelName(model)}`,
      images: [{ path: output, caption: `${prettyModelName(model)} at ${scale}×` }],
    };
  },
};
