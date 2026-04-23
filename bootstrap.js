if (typeof globalThis.File === "undefined") {
  globalThis.File = require("buffer").File;
}

require("./server.js");
