# Lightweight PDF

Lightweight PDF is a local MCP extension for Claude Desktop that makes PDFs much cheaper and easier for an LLM to use.

Instead of forcing the model to read an entire PDF as raw pages or screenshots, it extracts the document into a cleaner, structured payload:
- readable page text
- tables as machine-friendly arrays
- links with their destination URLs
- inline image blocks for important visuals
- whole-page visual fallback for pages that are mostly visual

Because the extraction happens locally on your machine first, Claude receives a much more compact and useful representation of the PDF than it would from a naive page-by-page visual read.

## Why It Saves Tokens

Lightweight PDF reduces token usage by preprocessing the PDF before the model sees it.

Token savings come from a few things:
- Normal text pages are returned as extracted text instead of sending full-page screenshots.
- Tables are emitted as compact structured arrays instead of forcing the model to infer rows and columns from visual layout.
- Repeated headers and footers are stripped so the same boilerplate is not paid for over and over.
- Images are only returned when they are actually useful, instead of turning every page into one large image.
- Scan-like or low-text pages only fall back to full-page images when text extraction would be poor.
- Large PDFs can be extracted in page batches, which helps stay inside MCP response limits and avoids wasting context on pages you do not need yet.

In short: the MCP server does the heavy PDF work locally, then sends Claude a cleaner text-and-image representation instead of making the model reconstruct the document structure by itself.

## Main Features

- Canonical text output with stable page ordering
- Structured table extraction with explicit JSON-array formatting
- Link extraction with destination URLs preserved
- Inline image extraction for supported embedded images
- Whole-page visual fallback for low-text or visual pages
- OCR fallback with Tesseract for scanned/image-only PDFs
- Local Windows file path support
- Support for Claude upload paths and HTTPS PDFs
- Page-range extraction for large PDFs
- Export-friendly output: canonical text, JSON results, MCP response, and images

## What It Extracts

When the tool works on a PDF, it can return:
- document title and outline
- clean page text
- structured tables
- hyperlinks and annotations
- cropped inline images
- full-page fallback images when needed

This makes it useful for:
- reading long PDFs in Claude without wasting as many tokens
- extracting tables into a machine-readable format
- reviewing mixed-content PDFs with text, tables, links, and images
- exporting a reusable local extraction bundle

## Requirements

| Requirement | Version | Notes |
|---|---|---|
| Windows | Any | Current install guide is Windows-focused |
| Claude Desktop | Latest | Required |
| Tesseract OCR | 5.x | Optional, needed for OCR on scanned pages |

## Installation

### Step 1: Download the files

1. Go to the [Releases page](https://github.com/noobieisgod/Lightweight-PDF/releases)
2. Download the ZIP file
3. Extract the ZIP file

### Step 2: Install Tesseract (optional, for OCR)

Tesseract enables text extraction from scanned or image-only PDF pages.

1. Download it from the [UB Mannheim Tesseract page](https://github.com/UB-Mannheim/tesseract/wiki)
2. Run the installer
3. Open Command Prompt as administrator and add Tesseract to `PATH` if needed
4. Verify the install with:

```powershell
tesseract --version
```

If Tesseract is not installed, scan-like pages fall back to a full-page visual image instead.

## Connecting to Claude Desktop

### Step 1: Setup

1. Open Claude Desktop
2. Go to `Settings -> Extensions -> Browser Extensions -> PDF (By Anthropic) -> Install`

### Step 2: Import

1. Go to `Settings -> Extensions -> Advanced Settings -> Install Extension`
2. Choose the unpacked folder and select the `.mcpb` file
3. Click install in the pop-up window

### Step 3: Confirmation

1. Fully restart Claude Desktop
2. Confirm the extension is working by asking Claude to use it on a local PDF path

## Usage

Example prompts:

```text
Use Lightweight PDF on C:\Users\Andy\Downloads\report.pdf
```

```text
Use Lightweight PDF on pages 1-3 of C:\Users\Andy\Downloads\report.pdf
```

```text
Extract pages 14-16 from this PDF with Lightweight PDF
```

For large PDFs, ask Claude to use page batches such as:
- `1-3`
- `4-8`
- `9-13`
- `14-16`

This helps avoid the MCP response size limit and keeps context usage lower.

## Potential Problems

### Local paths

Claude may sometimes incorrectly say it cannot use a local file path. That is not true for this extension.

Lightweight PDF runs locally on your machine, so it can access your filesystem directly. If the model says it cannot use a local path, tell it to try the full local path anyway.

### Large PDFs

Very long PDFs may:
- take longer to process
- hit MCP timeout limits
- exceed the MCP response size cap if returned all at once

If that happens, call the tool multiple times with different page ranges.

### OCR dependency

If Tesseract is not installed, scanned or image-only pages will not become searchable text. They will fall back to visual output instead.

## Current Status

The project currently performs best on:
- text-heavy PDFs
- PDFs with structured tables
- mixed PDFs where only some pages need visual fallback

It is especially useful when you want Claude to inspect a PDF while paying for a cleaner extracted representation instead of a full visual dump of every page.
