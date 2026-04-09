// Minimal polyfill for pdfjs-dist in Node.js server context.
// pdfjs-dist/legacy/build/pdf.mjs eagerly initializes DOMMatrix at the
// top level for its rendering pipeline, even when the server only uses
// text/metadata extraction (getDocument, getPage, getAnnotations).
// These stubs satisfy the module-level initialization without shipping
// ~130MB of @napi-rs/canvas native binaries.

if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = class DOMMatrix {
    constructor(init) {
      this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
      this.m11 = 1; this.m12 = 0; this.m13 = 0; this.m14 = 0;
      this.m21 = 0; this.m22 = 1; this.m23 = 0; this.m24 = 0;
      this.m31 = 0; this.m32 = 0; this.m33 = 1; this.m34 = 0;
      this.m41 = 0; this.m42 = 0; this.m43 = 0; this.m44 = 1;
      this.is2D = true; this.isIdentity = true;
    }
    static fromMatrix(other) { return new DOMMatrix(); }
    static fromFloat64Array(arr) { return new DOMMatrix(); }
    static fromFloat32Array(arr) { return new DOMMatrix(); }
    multiply() { return new DOMMatrix(); }
    inverse() { return new DOMMatrix(); }
    scale() { return new DOMMatrix(); }
    translate() { return new DOMMatrix(); }
    rotate() { return new DOMMatrix(); }
    transformPoint(p) { return { x: p?.x || 0, y: p?.y || 0, z: p?.z || 0, w: p?.w || 1 }; }
  };
}

if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(sw, sh) {
      this.width = sw; this.height = sh;
      this.data = new Uint8ClampedArray(sw * sh * 4);
    }
  };
}

if (typeof globalThis.Path2D === 'undefined') {
  globalThis.Path2D = class Path2D {
    constructor() {}
    addPath() {}
    moveTo() {}
    lineTo() {}
    bezierCurveTo() {}
    quadraticCurveTo() {}
    arc() {}
    arcTo() {}
    rect() {}
    closePath() {}
  };
}
