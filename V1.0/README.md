# pdf-extract-mcp

A Claude Desktop MCP extension that extracts content from PDF files — text, images, and tables — optimised for LLM consumption.

**Features:**
- Native text extraction with position-aware layout
- Automatic header and footer stripping
- Structured table detection (heuristic + PDF structure tree)
- Image extraction with perceptual deduplication
- OCR fallback via Tesseract for scan-like pages
- Full-page visual fallback for image-only pages
- Parallel page processing (5 pages at a time) to stay within timeout budgets

---

## Requirements

| Requirement | Version | Notes |
|---|---|---|
| [Node.js](https://nodejs.org/) | 18 or later | Required |
| [Claude Desktop](https://claude.ai/download) | Latest | Required |
| [@napi-rs/canvas](https://www.npmjs.com/package/@napi-rs/canvas) | 0.1.97 | Optional — needed for image extraction |
| [Tesseract OCR](https://github.com/tesseract-ocr/tesseract) | 5.x | Optional — needed for OCR on scanned pages |

---

## Installation

### Step 1 — Install Node.js

Download and install Node.js 18 or later from https://nodejs.org/

Verify:
```
node --version
```

### Step 2 — Clone the repository

```
git clone https://github.com/YOUR_USERNAME/pdf-extract-mcp.git
cd pdf-extract-mcp
```

### Step 3 — Install dependencies

```
npm install
```

This installs pdfjs-dist, the MCP SDK, and Zod. Image extraction and rendering are not available yet at this step — continue below if you need them.

### Step 4 — Install canvas (optional, for image extraction)

Image extraction and page rendering require `@napi-rs/canvas`. Install the package for your platform:

**Windows (x64):**
```
npm install @napi-rs/canvas-win32-x64-msvc
```

**macOS (Apple Silicon):**
```
npm install @napi-rs/canvas-darwin-arm64
```

**macOS (Intel):**
```
npm install @napi-rs/canvas-darwin-x64
```

**Linux (x64):**
```
npm install @napi-rs/canvas-linux-x64-gnu
```

If canvas is not installed, the extension still works — images will be listed with a fallback message instead of being returned as image blocks.

### Step 5 — Install Tesseract (optional, for OCR)

Tesseract enables text extraction from scanned or image-only PDF pages.

**Windows** — download the installer from the official Tesseract release page:
https://github.com/UB-Mannheim/tesseract/wiki

During installation, select **Add Tesseract to PATH**.

Verify:
```
tesseract --version
```

**macOS:**
```
brew install tesseract
```

**Linux (Ubuntu/Debian):**
```
sudo apt install tesseract-ocr
```

If Tesseract is not installed, scan-like pages fall back to a full-page visual image instead.

---

## Connecting to Claude Desktop

### Step 1 — Find your Claude Desktop config file

**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

### Step 2 — Add the server entry

Open `claude_desktop_config.json` in a text editor and add the `pdf-extract` entry inside `mcpServers`. Replace `C:/path/to/pdf-extract-mcp` with the actual path where you cloned the repository.

```json
{
  "mcpServers": {
    "pdf-extract": {
      "command": "node",
      "args": [
        "C:/path/to/pdf-extract-mcp/pdf-extract-addon.mjs",
        "--stdio"
      ]
    }
  }
}
```

**Windows path example:**
```json
"args": ["C:/Users/Andy/pdf-extract-mcp/pdf-extract-addon.mjs", "--stdio"]
```

**macOS path example:**
```json
"args": ["/Users/andy/pdf-extract-mcp/pdf-extract-addon.mjs", "--stdio"]
```

### Step 3 — Restart Claude Desktop

Fully quit and relaunch Claude Desktop. The `extract_pdf_content` tool will appear in the tools panel.

---

## Usage

Once connected, ask Claude to read any PDF:

> "Read my PDF at C:/Users/Andy/Documents/report.pdf"

> "Extract pages 5 to 10 from this PDF: https://example.com/paper.pdf"

The tool accepts:
- Local file paths (e.g. `C:/Users/Andy/report.pdf`)
- `file:///` URLs
- `https://` URLs

### Tool parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `url` | string | required | Local path or `https://` URL to the PDF |
| `pages` | array | all pages | Page ranges, e.g. `[{"start":1,"end":10}]` |
| `max_image_dim` | number | 768 | Max pixel dimension for returned images |

---

## Performance notes

- Pages are loaded in parallel (all at once) then processed in batches of 5
- For very large PDFs (100+ pages), request specific page ranges to stay within Claude Desktop's 60-second MCP timeout
- Image extraction adds significant time per page — use `max_image_dim: 256` to reduce it for image-heavy documents

---

## Troubleshooting

**"Canvas unavailable" messages next to images**
Canvas is not installed. Run the platform-specific install command in Step 4.

**Scanned pages show as images instead of text**
Tesseract is not installed or not on PATH. Install it following Step 5.

**Tool not appearing in Claude Desktop**
- Check the path in `claude_desktop_config.json` is correct and uses forward slashes
- Make sure `npm install` completed without errors
- Fully quit Claude Desktop (not just close the window) and relaunch
