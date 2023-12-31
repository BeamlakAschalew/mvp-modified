import * as unpacker from "unpacker";
import { load } from "cheerio";
import FormData from "form-data";
import CryptoJS from "crypto-js";
import ISO6391 from "iso-639-1";
import { customAlphabet } from "nanoid";
class NotFoundError extends Error {
  constructor(reason) {
    super(`Couldn't find a stream: ${reason ?? "not found"}`);
    this.name = "NotFoundError";
  }
}
function makeFullUrl(url, ops) {
  let leftSide = (ops == null ? void 0 : ops.baseUrl) ?? "";
  let rightSide = url;
  if (leftSide.length > 0 && !leftSide.endsWith("/"))
    leftSide += "/";
  if (rightSide.startsWith("/"))
    rightSide = rightSide.slice(1);
  const fullUrl = leftSide + rightSide;
  if (!fullUrl.startsWith("http://") && !fullUrl.startsWith("https://"))
    throw new Error(`Invald URL -- URL doesn't start with a http scheme: '${fullUrl}'`);
  const parsedUrl = new URL(fullUrl);
  Object.entries((ops == null ? void 0 : ops.query) ?? {}).forEach(([k, v]) => {
    parsedUrl.searchParams.set(k, v);
  });
  return parsedUrl.toString();
}
function makeFullFetcher(fetcher) {
  return (url, ops) => {
    return fetcher(url, {
      headers: (ops == null ? void 0 : ops.headers) ?? {},
      method: (ops == null ? void 0 : ops.method) ?? "GET",
      query: (ops == null ? void 0 : ops.query) ?? {},
      baseUrl: (ops == null ? void 0 : ops.baseUrl) ?? "",
      body: ops == null ? void 0 : ops.body
    });
  };
}
const flags = {
  NO_CORS: "no-cors"
};
const targets = {
  BROWSER: "browser",
  NATIVE: "native",
  ALL: "all"
};
const targetToFeatures = {
  browser: {
    requires: [flags.NO_CORS]
  },
  native: {
    requires: []
  },
  all: {
    requires: []
  }
};
function getTargetFeatures(target) {
  return targetToFeatures[target];
}
function flagsAllowedInFeatures(features, inputFlags) {
  const hasAllFlags = features.requires.every((v) => inputFlags.includes(v));
  if (!hasAllFlags)
    return false;
  return true;
}
function isValidStream(stream) {
  if (!stream)
    return false;
  if (stream.type === "hls") {
    if (!stream.playlist)
      return false;
    return true;
  }
  if (stream.type === "file") {
    const validQualities = Object.values(stream.qualities).filter((v) => v.url.length > 0);
    if (validQualities.length === 0)
      return false;
    return true;
  }
  return false;
}
async function scrapeInvidualSource(list, ops) {
  const sourceScraper = list.sources.find((v) => ops.id === v.id);
  if (!sourceScraper)
    throw new Error("Source with ID not found");
  if (ops.media.type === "movie" && !sourceScraper.scrapeMovie)
    throw new Error("Source is not compatible with movies");
  if (ops.media.type === "show" && !sourceScraper.scrapeShow)
    throw new Error("Source is not compatible with shows");
  const contextBase = {
    fetcher: ops.fetcher,
    proxiedFetcher: ops.proxiedFetcher,
    progress(val) {
      var _a, _b;
      (_b = (_a = ops.events) == null ? void 0 : _a.update) == null ? void 0 : _b.call(_a, {
        id: sourceScraper.id,
        percentage: val,
        status: "pending"
      });
    }
  };
  let output = null;
  if (ops.media.type === "movie" && sourceScraper.scrapeMovie)
    output = await sourceScraper.scrapeMovie({
      ...contextBase,
      media: ops.media
    });
  else if (ops.media.type === "show" && sourceScraper.scrapeShow)
    output = await sourceScraper.scrapeShow({
      ...contextBase,
      media: ops.media
    });
  if ((output == null ? void 0 : output.stream) && (!isValidStream(output.stream) || !flagsAllowedInFeatures(ops.features, output.stream.flags))) {
    output.stream = void 0;
  }
  if (!output)
    throw new Error("output is null");
  return output;
}
async function scrapeIndividualEmbed(list, ops) {
  const embedScraper = list.embeds.find((v) => ops.id === v.id);
  if (!embedScraper)
    throw new Error("Embed with ID not found");
  const output = await embedScraper.scrape({
    fetcher: ops.fetcher,
    proxiedFetcher: ops.proxiedFetcher,
    url: ops.url,
    progress(val) {
      var _a, _b;
      (_b = (_a = ops.events) == null ? void 0 : _a.update) == null ? void 0 : _b.call(_a, {
        id: embedScraper.id,
        percentage: val,
        status: "pending"
      });
    }
  });
  if (!isValidStream(output.stream))
    throw new NotFoundError("stream is incomplete");
  if (!flagsAllowedInFeatures(ops.features, output.stream.flags))
    throw new NotFoundError("stream doesn't satisfy target feature flags");
  return output;
}
function formatSourceMeta(v) {
  const types = [];
  if (v.scrapeMovie)
    types.push("movie");
  if (v.scrapeShow)
    types.push("show");
  return {
    type: "source",
    id: v.id,
    rank: v.rank,
    name: v.name,
    mediaTypes: types
  };
}
function formatEmbedMeta(v) {
  return {
    type: "embed",
    id: v.id,
    rank: v.rank,
    name: v.name
  };
}
function getAllSourceMetaSorted(list) {
  return list.sources.sort((a, b) => b.rank - a.rank).map(formatSourceMeta);
}
function getAllEmbedMetaSorted(list) {
  return list.embeds.sort((a, b) => b.rank - a.rank).map(formatEmbedMeta);
}
function getSpecificId(list, id) {
  const foundSource = list.sources.find((v) => v.id === id);
  if (foundSource) {
    return formatSourceMeta(foundSource);
  }
  const foundEmbed = list.embeds.find((v) => v.id === id);
  if (foundEmbed) {
    return formatEmbedMeta(foundEmbed);
  }
  return null;
}
function reorderOnIdList(order, list) {
  const copy = [...list];
  copy.sort((a, b) => {
    const aIndex = order.indexOf(a.id);
    const bIndex = order.indexOf(b.id);
    if (aIndex >= 0 && bIndex >= 0)
      return aIndex - bIndex;
    if (bIndex >= 0)
      return 1;
    if (aIndex >= 0)
      return -1;
    return b.rank - a.rank;
  });
  return copy;
}
async function runAllProviders(list, ops) {
  var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p;
  const sources = reorderOnIdList(ops.sourceOrder ?? [], list.sources).filter((v) => {
    if (ops.media.type === "movie")
      return !!v.scrapeMovie;
    if (ops.media.type === "show")
      return !!v.scrapeShow;
    return false;
  });
  const embeds = reorderOnIdList(ops.embedOrder ?? [], list.embeds);
  const embedIds = embeds.map((v) => v.id);
  let lastId = "";
  const contextBase = {
    fetcher: ops.fetcher,
    proxiedFetcher: ops.proxiedFetcher,
    progress(val) {
      var _a2, _b2;
      (_b2 = (_a2 = ops.events) == null ? void 0 : _a2.update) == null ? void 0 : _b2.call(_a2, {
        id: lastId,
        percentage: val,
        status: "pending"
      });
    }
  };
  (_b = (_a = ops.events) == null ? void 0 : _a.init) == null ? void 0 : _b.call(_a, {
    sourceIds: sources.map((v) => v.id)
  });
  for (const s of sources) {
    (_d = (_c = ops.events) == null ? void 0 : _c.start) == null ? void 0 : _d.call(_c, s.id);
    lastId = s.id;
    let output = null;
    try {
      if (ops.media.type === "movie" && s.scrapeMovie)
        output = await s.scrapeMovie({
          ...contextBase,
          media: ops.media
        });
      else if (ops.media.type === "show" && s.scrapeShow)
        output = await s.scrapeShow({
          ...contextBase,
          media: ops.media
        });
      if ((output == null ? void 0 : output.stream) && !isValidStream(output == null ? void 0 : output.stream)) {
        throw new NotFoundError("stream is incomplete");
      }
      if ((output == null ? void 0 : output.stream) && !flagsAllowedInFeatures(ops.features, output.stream.flags)) {
        throw new NotFoundError("stream doesn't satisfy target feature flags");
      }
    } catch (err) {
      if (err instanceof NotFoundError) {
        (_f = (_e = ops.events) == null ? void 0 : _e.update) == null ? void 0 : _f.call(_e, {
          id: s.id,
          percentage: 100,
          status: "notfound",
          reason: err.message
        });
        continue;
      }
      (_h = (_g = ops.events) == null ? void 0 : _g.update) == null ? void 0 : _h.call(_g, {
        id: s.id,
        percentage: 100,
        status: "failure",
        error: err
      });
      continue;
    }
    if (!output)
      throw new Error("Invalid media type");
    if (output.stream) {
      return {
        sourceId: s.id,
        stream: output.stream
      };
    }
    if (output.embeds.length > 0) {
      (_j = (_i = ops.events) == null ? void 0 : _i.discoverEmbeds) == null ? void 0 : _j.call(_i, {
        embeds: output.embeds.map((v, i) => ({
          id: [s.id, i].join("-"),
          embedScraperId: v.embedId
        })),
        sourceId: s.id
      });
    }
    const sortedEmbeds = output.embeds;
    sortedEmbeds.sort((a, b) => embedIds.indexOf(a.embedId) - embedIds.indexOf(b.embedId));
    for (const ind in sortedEmbeds) {
      if (!Object.prototype.hasOwnProperty.call(sortedEmbeds, ind))
        continue;
      const e = sortedEmbeds[ind];
      const scraper = embeds.find((v) => v.id === e.embedId);
      if (!scraper)
        throw new Error("Invalid embed returned");
      const id = [s.id, ind].join("-");
      (_l = (_k = ops.events) == null ? void 0 : _k.start) == null ? void 0 : _l.call(_k, id);
      lastId = id;
      let embedOutput;
      try {
        embedOutput = await scraper.scrape({
          ...contextBase,
          url: e.url
        });
        if (!flagsAllowedInFeatures(ops.features, embedOutput.stream.flags)) {
          throw new NotFoundError("stream doesn't satisfy target feature flags");
        }
      } catch (err) {
        if (err instanceof NotFoundError) {
          (_n = (_m = ops.events) == null ? void 0 : _m.update) == null ? void 0 : _n.call(_m, {
            id,
            percentage: 100,
            status: "notfound",
            reason: err.message
          });
          continue;
        }
        (_p = (_o = ops.events) == null ? void 0 : _o.update) == null ? void 0 : _p.call(_o, {
          id,
          percentage: 100,
          status: "failure",
          error: err
        });
        continue;
      }
      return {
        sourceId: s.id,
        embedId: scraper.id,
        stream: embedOutput.stream
      };
    }
  }
  return null;
}
function makeSourcerer(state) {
  return state;
}
function makeEmbed(state) {
  return state;
}
const febBoxBase = `https://www.febbox.com`;
const allowedQualities$1 = ["360", "480", "720", "1080"];
const febBoxScraper = makeEmbed({
  id: "febbox",
  name: "FebBox",
  rank: 160,
  async scrape(ctx) {
    var _a, _b, _c;
    const shareKey = ctx.url.split("/")[4];
    const streams = await ctx.proxiedFetcher("/file/file_share_list", {
      headers: {
        "accept-language": "en"
        // without this header, the request is marked as a webscraper
      },
      baseUrl: febBoxBase,
      query: {
        share_key: shareKey,
        pwd: ""
      }
    });
    const fid = (_c = (_b = (_a = streams == null ? void 0 : streams.data) == null ? void 0 : _a.file_list) == null ? void 0 : _b[0]) == null ? void 0 : _c.fid;
    if (!fid)
      throw new NotFoundError("no result found");
    const formParams = new URLSearchParams();
    formParams.append("fid", fid);
    formParams.append("share_key", shareKey);
    const player = await ctx.proxiedFetcher("/file/player", {
      baseUrl: febBoxBase,
      body: formParams,
      method: "POST",
      headers: {
        "accept-language": "en"
        // without this header, the request is marked as a webscraper
      }
    });
    const sourcesMatch = player == null ? void 0 : player.match(/var sources = (\[[^\]]+\]);/);
    const qualities = sourcesMatch ? JSON.parse(sourcesMatch[0].replace("var sources = ", "").replace(";", "")) : null;
    const embedQualities = {};
    qualities.forEach((quality) => {
      const normalizedLabel = quality.label.toLowerCase().replace("p", "");
      if (allowedQualities$1.includes(normalizedLabel)) {
        if (!quality.file)
          return;
        embedQualities[normalizedLabel] = {
          type: "mp4",
          url: quality.file
        };
      }
    });
    return {
      stream: {
        type: "file",
        captions: [],
        flags: [flags.NO_CORS],
        qualities: embedQualities
      }
    };
  }
});
const packedRegex$1 = /(eval\(function\(p,a,c,k,e,d\){.*{}\)\))/;
const linkRegex$1 = /MDCore\.wurl="(.*?)";/;
const mixdropScraper = makeEmbed({
  id: "mixdrop",
  name: "MixDrop",
  rank: 198,
  async scrape(ctx) {
    const streamRes = await ctx.proxiedFetcher(ctx.url);
    const packed = streamRes.match(packedRegex$1);
    if (!packed) {
      throw new Error("failed to find packed mixdrop JavaScript");
    }
    const unpacked = unpacker.unpack(packed[1]);
    const link = unpacked.match(linkRegex$1);
    if (!link) {
      throw new Error("failed to find packed mixdrop source link");
    }
    const url = link[1];
    return {
      stream: {
        type: "file",
        flags: [],
        captions: [],
        qualities: {
          unknown: {
            type: "mp4",
            url: url.startsWith("http") ? url : `https:${url}`,
            // URLs don't always start with the protocol
            headers: {
              // MixDrop requires this header on all streams
              Referer: "https://mixdrop.co/"
            }
          }
        }
      }
    };
  }
});
const mp4uploadScraper = makeEmbed({
  id: "mp4upload",
  name: "mp4upload",
  rank: 170,
  async scrape(ctx) {
    const embed = await ctx.proxiedFetcher(ctx.url);
    const playerSrcRegex = new RegExp('(?<=player\\.src\\()\\s*{\\s*type:\\s*"[^"]+",\\s*src:\\s*"([^"]+)"\\s*}\\s*(?=\\);)', "s");
    const playerSrc = embed.match(playerSrcRegex) ?? [];
    const streamUrl = playerSrc[1];
    if (!streamUrl)
      throw new Error("Stream url not found in embed code");
    return {
      stream: {
        type: "file",
        flags: [flags.NO_CORS],
        captions: [],
        qualities: {
          "1080": {
            type: "mp4",
            url: streamUrl
          }
        }
      }
    };
  }
});
var commonjsGlobal = typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : {};
function getDefaultExportFromCjs(x) {
  return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, "default") ? x["default"] : x;
}
function getAugmentedNamespace(n) {
  if (n.__esModule)
    return n;
  var f = n.default;
  if (typeof f == "function") {
    var a = function a2() {
      if (this instanceof a2) {
        var args = [null];
        args.push.apply(args, arguments);
        var Ctor = Function.bind.apply(f, args);
        return new Ctor();
      }
      return f.apply(this, arguments);
    };
    a.prototype = f.prototype;
  } else
    a = {};
  Object.defineProperty(a, "__esModule", { value: true });
  Object.keys(n).forEach(function(k) {
    var d = Object.getOwnPropertyDescriptor(n, k);
    Object.defineProperty(a, k, d.get ? d : {
      enumerable: true,
      get: function() {
        return n[k];
      }
    });
  });
  return a;
}
var encBase64 = { exports: {} };
function commonjsRequire(path) {
  throw new Error('Could not dynamically require "' + path + '". Please configure the dynamicRequireTargets or/and ignoreDynamicRequires option of @rollup/plugin-commonjs appropriately for this require call to work.');
}
var core = { exports: {} };
const __viteBrowserExternal = {};
const __viteBrowserExternal$1 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: __viteBrowserExternal
}, Symbol.toStringTag, { value: "Module" }));
const require$$0 = /* @__PURE__ */ getAugmentedNamespace(__viteBrowserExternal$1);
var hasRequiredCore;
function requireCore() {
  if (hasRequiredCore)
    return core.exports;
  hasRequiredCore = 1;
  (function(module, exports) {
    (function(root, factory) {
      {
        module.exports = factory();
      }
    })(commonjsGlobal, function() {
      var CryptoJS2 = CryptoJS2 || function(Math2, undefined$1) {
        var crypto;
        if (typeof window !== "undefined" && window.crypto) {
          crypto = window.crypto;
        }
        if (typeof self !== "undefined" && self.crypto) {
          crypto = self.crypto;
        }
        if (typeof globalThis !== "undefined" && globalThis.crypto) {
          crypto = globalThis.crypto;
        }
        if (!crypto && typeof window !== "undefined" && window.msCrypto) {
          crypto = window.msCrypto;
        }
        if (!crypto && typeof commonjsGlobal !== "undefined" && commonjsGlobal.crypto) {
          crypto = commonjsGlobal.crypto;
        }
        if (!crypto && typeof commonjsRequire === "function") {
          try {
            crypto = require$$0;
          } catch (err) {
          }
        }
        var cryptoSecureRandomInt = function() {
          if (crypto) {
            if (typeof crypto.getRandomValues === "function") {
              try {
                return crypto.getRandomValues(new Uint32Array(1))[0];
              } catch (err) {
              }
            }
            if (typeof crypto.randomBytes === "function") {
              try {
                return crypto.randomBytes(4).readInt32LE();
              } catch (err) {
              }
            }
          }
          throw new Error("Native crypto module could not be used to get secure random number.");
        };
        var create = Object.create || function() {
          function F() {
          }
          return function(obj) {
            var subtype;
            F.prototype = obj;
            subtype = new F();
            F.prototype = null;
            return subtype;
          };
        }();
        var C = {};
        var C_lib = C.lib = {};
        var Base = C_lib.Base = function() {
          return {
            /**
             * Creates a new object that inherits from this object.
             *
             * @param {Object} overrides Properties to copy into the new object.
             *
             * @return {Object} The new object.
             *
             * @static
             *
             * @example
             *
             *     var MyType = CryptoJS.lib.Base.extend({
             *         field: 'value',
             *
             *         method: function () {
             *         }
             *     });
             */
            extend: function(overrides) {
              var subtype = create(this);
              if (overrides) {
                subtype.mixIn(overrides);
              }
              if (!subtype.hasOwnProperty("init") || this.init === subtype.init) {
                subtype.init = function() {
                  subtype.$super.init.apply(this, arguments);
                };
              }
              subtype.init.prototype = subtype;
              subtype.$super = this;
              return subtype;
            },
            /**
             * Extends this object and runs the init method.
             * Arguments to create() will be passed to init().
             *
             * @return {Object} The new object.
             *
             * @static
             *
             * @example
             *
             *     var instance = MyType.create();
             */
            create: function() {
              var instance = this.extend();
              instance.init.apply(instance, arguments);
              return instance;
            },
            /**
             * Initializes a newly created object.
             * Override this method to add some logic when your objects are created.
             *
             * @example
             *
             *     var MyType = CryptoJS.lib.Base.extend({
             *         init: function () {
             *             // ...
             *         }
             *     });
             */
            init: function() {
            },
            /**
             * Copies properties into this object.
             *
             * @param {Object} properties The properties to mix in.
             *
             * @example
             *
             *     MyType.mixIn({
             *         field: 'value'
             *     });
             */
            mixIn: function(properties) {
              for (var propertyName in properties) {
                if (properties.hasOwnProperty(propertyName)) {
                  this[propertyName] = properties[propertyName];
                }
              }
              if (properties.hasOwnProperty("toString")) {
                this.toString = properties.toString;
              }
            },
            /**
             * Creates a copy of this object.
             *
             * @return {Object} The clone.
             *
             * @example
             *
             *     var clone = instance.clone();
             */
            clone: function() {
              return this.init.prototype.extend(this);
            }
          };
        }();
        var WordArray = C_lib.WordArray = Base.extend({
          /**
           * Initializes a newly created word array.
           *
           * @param {Array} words (Optional) An array of 32-bit words.
           * @param {number} sigBytes (Optional) The number of significant bytes in the words.
           *
           * @example
           *
           *     var wordArray = CryptoJS.lib.WordArray.create();
           *     var wordArray = CryptoJS.lib.WordArray.create([0x00010203, 0x04050607]);
           *     var wordArray = CryptoJS.lib.WordArray.create([0x00010203, 0x04050607], 6);
           */
          init: function(words, sigBytes) {
            words = this.words = words || [];
            if (sigBytes != undefined$1) {
              this.sigBytes = sigBytes;
            } else {
              this.sigBytes = words.length * 4;
            }
          },
          /**
           * Converts this word array to a string.
           *
           * @param {Encoder} encoder (Optional) The encoding strategy to use. Default: CryptoJS.enc.Hex
           *
           * @return {string} The stringified word array.
           *
           * @example
           *
           *     var string = wordArray + '';
           *     var string = wordArray.toString();
           *     var string = wordArray.toString(CryptoJS.enc.Utf8);
           */
          toString: function(encoder) {
            return (encoder || Hex).stringify(this);
          },
          /**
           * Concatenates a word array to this word array.
           *
           * @param {WordArray} wordArray The word array to append.
           *
           * @return {WordArray} This word array.
           *
           * @example
           *
           *     wordArray1.concat(wordArray2);
           */
          concat: function(wordArray) {
            var thisWords = this.words;
            var thatWords = wordArray.words;
            var thisSigBytes = this.sigBytes;
            var thatSigBytes = wordArray.sigBytes;
            this.clamp();
            if (thisSigBytes % 4) {
              for (var i = 0; i < thatSigBytes; i++) {
                var thatByte = thatWords[i >>> 2] >>> 24 - i % 4 * 8 & 255;
                thisWords[thisSigBytes + i >>> 2] |= thatByte << 24 - (thisSigBytes + i) % 4 * 8;
              }
            } else {
              for (var j = 0; j < thatSigBytes; j += 4) {
                thisWords[thisSigBytes + j >>> 2] = thatWords[j >>> 2];
              }
            }
            this.sigBytes += thatSigBytes;
            return this;
          },
          /**
           * Removes insignificant bits.
           *
           * @example
           *
           *     wordArray.clamp();
           */
          clamp: function() {
            var words = this.words;
            var sigBytes = this.sigBytes;
            words[sigBytes >>> 2] &= 4294967295 << 32 - sigBytes % 4 * 8;
            words.length = Math2.ceil(sigBytes / 4);
          },
          /**
           * Creates a copy of this word array.
           *
           * @return {WordArray} The clone.
           *
           * @example
           *
           *     var clone = wordArray.clone();
           */
          clone: function() {
            var clone = Base.clone.call(this);
            clone.words = this.words.slice(0);
            return clone;
          },
          /**
           * Creates a word array filled with random bytes.
           *
           * @param {number} nBytes The number of random bytes to generate.
           *
           * @return {WordArray} The random word array.
           *
           * @static
           *
           * @example
           *
           *     var wordArray = CryptoJS.lib.WordArray.random(16);
           */
          random: function(nBytes) {
            var words = [];
            for (var i = 0; i < nBytes; i += 4) {
              words.push(cryptoSecureRandomInt());
            }
            return new WordArray.init(words, nBytes);
          }
        });
        var C_enc = C.enc = {};
        var Hex = C_enc.Hex = {
          /**
           * Converts a word array to a hex string.
           *
           * @param {WordArray} wordArray The word array.
           *
           * @return {string} The hex string.
           *
           * @static
           *
           * @example
           *
           *     var hexString = CryptoJS.enc.Hex.stringify(wordArray);
           */
          stringify: function(wordArray) {
            var words = wordArray.words;
            var sigBytes = wordArray.sigBytes;
            var hexChars = [];
            for (var i = 0; i < sigBytes; i++) {
              var bite = words[i >>> 2] >>> 24 - i % 4 * 8 & 255;
              hexChars.push((bite >>> 4).toString(16));
              hexChars.push((bite & 15).toString(16));
            }
            return hexChars.join("");
          },
          /**
           * Converts a hex string to a word array.
           *
           * @param {string} hexStr The hex string.
           *
           * @return {WordArray} The word array.
           *
           * @static
           *
           * @example
           *
           *     var wordArray = CryptoJS.enc.Hex.parse(hexString);
           */
          parse: function(hexStr) {
            var hexStrLength = hexStr.length;
            var words = [];
            for (var i = 0; i < hexStrLength; i += 2) {
              words[i >>> 3] |= parseInt(hexStr.substr(i, 2), 16) << 24 - i % 8 * 4;
            }
            return new WordArray.init(words, hexStrLength / 2);
          }
        };
        var Latin1 = C_enc.Latin1 = {
          /**
           * Converts a word array to a Latin1 string.
           *
           * @param {WordArray} wordArray The word array.
           *
           * @return {string} The Latin1 string.
           *
           * @static
           *
           * @example
           *
           *     var latin1String = CryptoJS.enc.Latin1.stringify(wordArray);
           */
          stringify: function(wordArray) {
            var words = wordArray.words;
            var sigBytes = wordArray.sigBytes;
            var latin1Chars = [];
            for (var i = 0; i < sigBytes; i++) {
              var bite = words[i >>> 2] >>> 24 - i % 4 * 8 & 255;
              latin1Chars.push(String.fromCharCode(bite));
            }
            return latin1Chars.join("");
          },
          /**
           * Converts a Latin1 string to a word array.
           *
           * @param {string} latin1Str The Latin1 string.
           *
           * @return {WordArray} The word array.
           *
           * @static
           *
           * @example
           *
           *     var wordArray = CryptoJS.enc.Latin1.parse(latin1String);
           */
          parse: function(latin1Str) {
            var latin1StrLength = latin1Str.length;
            var words = [];
            for (var i = 0; i < latin1StrLength; i++) {
              words[i >>> 2] |= (latin1Str.charCodeAt(i) & 255) << 24 - i % 4 * 8;
            }
            return new WordArray.init(words, latin1StrLength);
          }
        };
        var Utf82 = C_enc.Utf8 = {
          /**
           * Converts a word array to a UTF-8 string.
           *
           * @param {WordArray} wordArray The word array.
           *
           * @return {string} The UTF-8 string.
           *
           * @static
           *
           * @example
           *
           *     var utf8String = CryptoJS.enc.Utf8.stringify(wordArray);
           */
          stringify: function(wordArray) {
            try {
              return decodeURIComponent(escape(Latin1.stringify(wordArray)));
            } catch (e) {
              throw new Error("Malformed UTF-8 data");
            }
          },
          /**
           * Converts a UTF-8 string to a word array.
           *
           * @param {string} utf8Str The UTF-8 string.
           *
           * @return {WordArray} The word array.
           *
           * @static
           *
           * @example
           *
           *     var wordArray = CryptoJS.enc.Utf8.parse(utf8String);
           */
          parse: function(utf8Str) {
            return Latin1.parse(unescape(encodeURIComponent(utf8Str)));
          }
        };
        var BufferedBlockAlgorithm = C_lib.BufferedBlockAlgorithm = Base.extend({
          /**
           * Resets this block algorithm's data buffer to its initial state.
           *
           * @example
           *
           *     bufferedBlockAlgorithm.reset();
           */
          reset: function() {
            this._data = new WordArray.init();
            this._nDataBytes = 0;
          },
          /**
           * Adds new data to this block algorithm's buffer.
           *
           * @param {WordArray|string} data The data to append. Strings are converted to a WordArray using UTF-8.
           *
           * @example
           *
           *     bufferedBlockAlgorithm._append('data');
           *     bufferedBlockAlgorithm._append(wordArray);
           */
          _append: function(data) {
            if (typeof data == "string") {
              data = Utf82.parse(data);
            }
            this._data.concat(data);
            this._nDataBytes += data.sigBytes;
          },
          /**
           * Processes available data blocks.
           *
           * This method invokes _doProcessBlock(offset), which must be implemented by a concrete subtype.
           *
           * @param {boolean} doFlush Whether all blocks and partial blocks should be processed.
           *
           * @return {WordArray} The processed data.
           *
           * @example
           *
           *     var processedData = bufferedBlockAlgorithm._process();
           *     var processedData = bufferedBlockAlgorithm._process(!!'flush');
           */
          _process: function(doFlush) {
            var processedWords;
            var data = this._data;
            var dataWords = data.words;
            var dataSigBytes = data.sigBytes;
            var blockSize = this.blockSize;
            var blockSizeBytes = blockSize * 4;
            var nBlocksReady = dataSigBytes / blockSizeBytes;
            if (doFlush) {
              nBlocksReady = Math2.ceil(nBlocksReady);
            } else {
              nBlocksReady = Math2.max((nBlocksReady | 0) - this._minBufferSize, 0);
            }
            var nWordsReady = nBlocksReady * blockSize;
            var nBytesReady = Math2.min(nWordsReady * 4, dataSigBytes);
            if (nWordsReady) {
              for (var offset = 0; offset < nWordsReady; offset += blockSize) {
                this._doProcessBlock(dataWords, offset);
              }
              processedWords = dataWords.splice(0, nWordsReady);
              data.sigBytes -= nBytesReady;
            }
            return new WordArray.init(processedWords, nBytesReady);
          },
          /**
           * Creates a copy of this object.
           *
           * @return {Object} The clone.
           *
           * @example
           *
           *     var clone = bufferedBlockAlgorithm.clone();
           */
          clone: function() {
            var clone = Base.clone.call(this);
            clone._data = this._data.clone();
            return clone;
          },
          _minBufferSize: 0
        });
        C_lib.Hasher = BufferedBlockAlgorithm.extend({
          /**
           * Configuration options.
           */
          cfg: Base.extend(),
          /**
           * Initializes a newly created hasher.
           *
           * @param {Object} cfg (Optional) The configuration options to use for this hash computation.
           *
           * @example
           *
           *     var hasher = CryptoJS.algo.SHA256.create();
           */
          init: function(cfg) {
            this.cfg = this.cfg.extend(cfg);
            this.reset();
          },
          /**
           * Resets this hasher to its initial state.
           *
           * @example
           *
           *     hasher.reset();
           */
          reset: function() {
            BufferedBlockAlgorithm.reset.call(this);
            this._doReset();
          },
          /**
           * Updates this hasher with a message.
           *
           * @param {WordArray|string} messageUpdate The message to append.
           *
           * @return {Hasher} This hasher.
           *
           * @example
           *
           *     hasher.update('message');
           *     hasher.update(wordArray);
           */
          update: function(messageUpdate) {
            this._append(messageUpdate);
            this._process();
            return this;
          },
          /**
           * Finalizes the hash computation.
           * Note that the finalize operation is effectively a destructive, read-once operation.
           *
           * @param {WordArray|string} messageUpdate (Optional) A final message update.
           *
           * @return {WordArray} The hash.
           *
           * @example
           *
           *     var hash = hasher.finalize();
           *     var hash = hasher.finalize('message');
           *     var hash = hasher.finalize(wordArray);
           */
          finalize: function(messageUpdate) {
            if (messageUpdate) {
              this._append(messageUpdate);
            }
            var hash = this._doFinalize();
            return hash;
          },
          blockSize: 512 / 32,
          /**
           * Creates a shortcut function to a hasher's object interface.
           *
           * @param {Hasher} hasher The hasher to create a helper for.
           *
           * @return {Function} The shortcut function.
           *
           * @static
           *
           * @example
           *
           *     var SHA256 = CryptoJS.lib.Hasher._createHelper(CryptoJS.algo.SHA256);
           */
          _createHelper: function(hasher) {
            return function(message, cfg) {
              return new hasher.init(cfg).finalize(message);
            };
          },
          /**
           * Creates a shortcut function to the HMAC's object interface.
           *
           * @param {Hasher} hasher The hasher to use in this HMAC helper.
           *
           * @return {Function} The shortcut function.
           *
           * @static
           *
           * @example
           *
           *     var HmacSHA256 = CryptoJS.lib.Hasher._createHmacHelper(CryptoJS.algo.SHA256);
           */
          _createHmacHelper: function(hasher) {
            return function(message, key2) {
              return new C_algo.HMAC.init(hasher, key2).finalize(message);
            };
          }
        });
        var C_algo = C.algo = {};
        return C;
      }(Math);
      return CryptoJS2;
    });
  })(core);
  return core.exports;
}
(function(module, exports) {
  (function(root, factory) {
    {
      module.exports = factory(requireCore());
    }
  })(commonjsGlobal, function(CryptoJS2) {
    (function() {
      var C = CryptoJS2;
      var C_lib = C.lib;
      var WordArray = C_lib.WordArray;
      var C_enc = C.enc;
      C_enc.Base64 = {
        /**
         * Converts a word array to a Base64 string.
         *
         * @param {WordArray} wordArray The word array.
         *
         * @return {string} The Base64 string.
         *
         * @static
         *
         * @example
         *
         *     var base64String = CryptoJS.enc.Base64.stringify(wordArray);
         */
        stringify: function(wordArray) {
          var words = wordArray.words;
          var sigBytes = wordArray.sigBytes;
          var map = this._map;
          wordArray.clamp();
          var base64Chars = [];
          for (var i = 0; i < sigBytes; i += 3) {
            var byte1 = words[i >>> 2] >>> 24 - i % 4 * 8 & 255;
            var byte2 = words[i + 1 >>> 2] >>> 24 - (i + 1) % 4 * 8 & 255;
            var byte3 = words[i + 2 >>> 2] >>> 24 - (i + 2) % 4 * 8 & 255;
            var triplet = byte1 << 16 | byte2 << 8 | byte3;
            for (var j = 0; j < 4 && i + j * 0.75 < sigBytes; j++) {
              base64Chars.push(map.charAt(triplet >>> 6 * (3 - j) & 63));
            }
          }
          var paddingChar = map.charAt(64);
          if (paddingChar) {
            while (base64Chars.length % 4) {
              base64Chars.push(paddingChar);
            }
          }
          return base64Chars.join("");
        },
        /**
         * Converts a Base64 string to a word array.
         *
         * @param {string} base64Str The Base64 string.
         *
         * @return {WordArray} The word array.
         *
         * @static
         *
         * @example
         *
         *     var wordArray = CryptoJS.enc.Base64.parse(base64String);
         */
        parse: function(base64Str) {
          var base64StrLength = base64Str.length;
          var map = this._map;
          var reverseMap = this._reverseMap;
          if (!reverseMap) {
            reverseMap = this._reverseMap = [];
            for (var j = 0; j < map.length; j++) {
              reverseMap[map.charCodeAt(j)] = j;
            }
          }
          var paddingChar = map.charAt(64);
          if (paddingChar) {
            var paddingIndex = base64Str.indexOf(paddingChar);
            if (paddingIndex !== -1) {
              base64StrLength = paddingIndex;
            }
          }
          return parseLoop(base64Str, base64StrLength, reverseMap);
        },
        _map: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
      };
      function parseLoop(base64Str, base64StrLength, reverseMap) {
        var words = [];
        var nBytes = 0;
        for (var i = 0; i < base64StrLength; i++) {
          if (i % 4) {
            var bits1 = reverseMap[base64Str.charCodeAt(i - 1)] << i % 4 * 2;
            var bits2 = reverseMap[base64Str.charCodeAt(i)] >>> 6 - i % 4 * 2;
            var bitsCombined = bits1 | bits2;
            words[nBytes >>> 2] |= bitsCombined << 24 - nBytes % 4 * 8;
            nBytes++;
          }
        }
        return WordArray.create(words, nBytes);
      }
    })();
    return CryptoJS2.enc.Base64;
  });
})(encBase64);
var encBase64Exports = encBase64.exports;
const Base64 = /* @__PURE__ */ getDefaultExportFromCjs(encBase64Exports);
var encUtf8 = { exports: {} };
(function(module, exports) {
  (function(root, factory) {
    {
      module.exports = factory(requireCore());
    }
  })(commonjsGlobal, function(CryptoJS2) {
    return CryptoJS2.enc.Utf8;
  });
})(encUtf8);
var encUtf8Exports = encUtf8.exports;
const Utf8 = /* @__PURE__ */ getDefaultExportFromCjs(encUtf8Exports);
async function fetchCaptchaToken(ctx, domain, recaptchaKey) {
  const domainHash = Base64.stringify(Utf8.parse(domain)).replace(/=/g, ".");
  const recaptchaRender = await ctx.proxiedFetcher(`https://www.google.com/recaptcha/api.js`, {
    query: {
      render: recaptchaKey
    }
  });
  const vToken = recaptchaRender.substring(
    recaptchaRender.indexOf("/releases/") + 10,
    recaptchaRender.indexOf("/recaptcha__en.js")
  );
  const recaptchaAnchor = await ctx.proxiedFetcher(
    `https://www.google.com/recaptcha/api2/anchor?cb=1&hl=en&size=invisible&cb=flicklax`,
    {
      query: {
        k: recaptchaKey,
        co: domainHash,
        v: vToken
      }
    }
  );
  const cToken = load(recaptchaAnchor)("#recaptcha-token").attr("value");
  if (!cToken)
    throw new Error("Unable to find cToken");
  const tokenData = await ctx.proxiedFetcher(`https://www.google.com/recaptcha/api2/reload`, {
    query: {
      v: vToken,
      reason: "q",
      k: recaptchaKey,
      c: cToken,
      sa: "",
      co: domain
    },
    headers: { referer: "https://www.google.com/recaptcha/api2/" },
    method: "POST"
  });
  const token = tokenData.match('rresp","(.+?)"');
  return token ? token[1] : null;
}
const streamsbScraper = makeEmbed({
  id: "streamsb",
  name: "StreamSB",
  rank: 150,
  async scrape(ctx) {
    const streamsbUrl = ctx.url.replace(".html", "").replace("embed-", "").replace("e/", "").replace("d/", "");
    const parsedUrl = new URL(streamsbUrl);
    const base = await ctx.proxiedFetcher(`${parsedUrl.origin}/d${parsedUrl.pathname}`);
    ctx.progress(20);
    const pageDoc = load(base);
    const dlDetails = [];
    pageDoc("[onclick^=download_video]").each((i, el) => {
      const $el = pageDoc(el);
      const funcContents = $el.attr("onclick");
      const regExpFunc = /download_video\('(.+?)','(.+?)','(.+?)'\)/;
      const matchesFunc = regExpFunc.exec(funcContents ?? "");
      if (!matchesFunc)
        return;
      const quality = $el.find("span").text();
      const regExpQuality = /(.+?) \((.+?)\)/;
      const matchesQuality = regExpQuality.exec(quality ?? "");
      if (!matchesQuality)
        return;
      dlDetails.push({
        parameters: [matchesFunc[1], matchesFunc[2], matchesFunc[3]],
        quality: {
          label: matchesQuality[1].trim(),
          size: matchesQuality[2]
        }
      });
    });
    ctx.progress(40);
    let dls = await Promise.all(
      dlDetails.map(async (dl) => {
        const query = {
          op: "download_orig",
          id: dl.parameters[0],
          mode: dl.parameters[1],
          hash: dl.parameters[2]
        };
        const getDownload = await ctx.proxiedFetcher(`/dl`, {
          query,
          baseUrl: parsedUrl.origin
        });
        const downloadDoc = load(getDownload);
        const recaptchaKey = downloadDoc(".g-recaptcha").attr("data-sitekey");
        if (!recaptchaKey)
          throw new Error("Unable to get captcha key");
        const captchaToken = await fetchCaptchaToken(ctx, parsedUrl.origin, recaptchaKey);
        if (!captchaToken)
          throw new Error("Unable to get captcha token");
        const dlForm = new FormData();
        dlForm.append("op", "download_orig");
        dlForm.append("id", dl.parameters[0]);
        dlForm.append("mode", dl.parameters[1]);
        dlForm.append("hash", dl.parameters[2]);
        dlForm.append("g-recaptcha-response", captchaToken);
        const download = await ctx.proxiedFetcher(`/dl`, {
          method: "POST",
          baseUrl: parsedUrl.origin,
          body: dlForm,
          query
        });
        const dlLink = load(download)(".btn.btn-light.btn-lg").attr("href");
        return {
          quality: dl.quality.label,
          url: dlLink
        };
      })
    );
    dls = dls.filter((d) => !!d.url);
    ctx.progress(80);
    const qualities = dls.reduce((a, v) => {
      a[v.quality] = {
        type: "mp4",
        url: v.url
      };
      return a;
    }, {});
    return {
      stream: {
        type: "file",
        flags: [flags.NO_CORS],
        qualities,
        captions: []
      }
    };
  }
});
const captionTypes = {
  srt: "srt",
  vtt: "vtt"
};
function getCaptionTypeFromUrl(url) {
  const extensions = Object.keys(captionTypes);
  const type = extensions.find((v) => url.endsWith(`.${v}`));
  if (!type)
    return null;
  return type;
}
function labelToLanguageCode(label) {
  const code = ISO6391.getCode(label);
  if (code.length === 0)
    return null;
  return code;
}
function isValidLanguageCode(code) {
  if (!code)
    return false;
  return ISO6391.validate(code);
}
const { AES, enc } = CryptoJS;
function isJSON(json) {
  try {
    JSON.parse(json);
    return true;
  } catch {
    return false;
  }
}
function extractKey(script) {
  const startOfSwitch = script.lastIndexOf("switch");
  const endOfCases = script.indexOf("partKeyStartPosition");
  const switchBody = script.slice(startOfSwitch, endOfCases);
  const nums = [];
  const matches = switchBody.matchAll(/:[a-zA-Z0-9]+=([a-zA-Z0-9]+),[a-zA-Z0-9]+=([a-zA-Z0-9]+);/g);
  for (const match of matches) {
    const innerNumbers = [];
    for (const varMatch of [match[1], match[2]]) {
      const regex = new RegExp(`${varMatch}=0x([a-zA-Z0-9]+)`, "g");
      const varMatches = [...script.matchAll(regex)];
      const lastMatch = varMatches[varMatches.length - 1];
      if (!lastMatch)
        return null;
      const number = parseInt(lastMatch[1], 16);
      innerNumbers.push(number);
    }
    nums.push([innerNumbers[0], innerNumbers[1]]);
  }
  return nums;
}
const upcloudScraper = makeEmbed({
  id: "upcloud",
  name: "UpCloud",
  rank: 200,
  async scrape(ctx) {
    const parsedUrl = new URL(ctx.url.replace("embed-5", "embed-4"));
    const dataPath = parsedUrl.pathname.split("/");
    const dataId = dataPath[dataPath.length - 1];
    const streamRes = await ctx.proxiedFetcher(`${parsedUrl.origin}/ajax/embed-4/getSources?id=${dataId}`, {
      headers: {
        Referer: parsedUrl.origin,
        "X-Requested-With": "XMLHttpRequest"
      }
    });
    let sources = null;
    if (!isJSON(streamRes.sources)) {
      const scriptJs = await ctx.proxiedFetcher(`https://rabbitstream.net/js/player/prod/e4-player.min.js`);
      const decryptionKey = extractKey(scriptJs);
      if (!decryptionKey)
        throw new Error("Key extraction failed");
      let extractedKey = "";
      let strippedSources = streamRes.sources;
      let totalledOffset = 0;
      decryptionKey.forEach(([a, b]) => {
        const start = a + totalledOffset;
        const end = start + b;
        extractedKey += streamRes.sources.slice(start, end);
        strippedSources = strippedSources.replace(streamRes.sources.substring(start, end), "");
        totalledOffset += b;
      });
      const decryptedStream = AES.decrypt(strippedSources, extractedKey).toString(enc.Utf8);
      const parsedStream = JSON.parse(decryptedStream)[0];
      if (!parsedStream)
        throw new Error("No stream found");
      sources = parsedStream;
    }
    if (!sources)
      throw new Error("upcloud source not found");
    const captions = [];
    streamRes.tracks.forEach((track) => {
      if (track.kind !== "captions")
        return;
      const type = getCaptionTypeFromUrl(track.file);
      if (!type)
        return;
      const language = labelToLanguageCode(track.label);
      if (!language)
        return;
      captions.push({
        language,
        hasCorsRestrictions: false,
        type,
        url: track.file
      });
    });
    return {
      stream: {
        type: "hls",
        playlist: sources.file,
        flags: [flags.NO_CORS],
        captions
      }
    };
  }
});
const packedRegex = /(eval\(function\(p,a,c,k,e,d\).*\)\)\))/;
const linkRegex = /sources:\[{file:"(.*?)"/;
const upstreamScraper = makeEmbed({
  id: "upstream",
  name: "UpStream",
  rank: 199,
  async scrape(ctx) {
    const streamRes = await ctx.proxiedFetcher(ctx.url);
    const packed = streamRes.match(packedRegex);
    if (packed) {
      const unpacked = unpacker.unpack(packed[1]);
      const link = unpacked.match(linkRegex);
      if (link) {
        return {
          stream: {
            type: "hls",
            playlist: link[1],
            flags: [flags.NO_CORS],
            captions: []
          }
        };
      }
    }
    throw new Error("upstream source not found");
  }
});
const flixHqBase = "https://flixhq.to";
async function getFlixhqSourceDetails(ctx, sourceId) {
  const jsonData = await ctx.proxiedFetcher(`/ajax/sources/${sourceId}`, {
    baseUrl: flixHqBase
  });
  return jsonData.link;
}
async function getFlixhqMovieSources(ctx, media, id) {
  const episodeParts = id.split("-");
  const episodeId = episodeParts[episodeParts.length - 1];
  const data = await ctx.proxiedFetcher(`/ajax/movie/episodes/${episodeId}`, {
    baseUrl: flixHqBase
  });
  const doc = load(data);
  const sourceLinks = doc(".nav-item > a").toArray().map((el) => {
    const query = doc(el);
    const embedTitle = query.attr("title");
    const linkId = query.attr("data-linkid");
    if (!embedTitle || !linkId)
      throw new Error("invalid sources");
    return {
      embed: embedTitle,
      episodeId: linkId
    };
  });
  return sourceLinks;
}
async function getFlixhqShowSources(ctx, media, id) {
  var _a, _b;
  const episodeParts = id.split("-");
  const episodeId = episodeParts[episodeParts.length - 1];
  const seasonsListData = await ctx.proxiedFetcher(`/ajax/season/list/${episodeId}`, {
    baseUrl: flixHqBase
  });
  const seasonsDoc = load(seasonsListData);
  const season = (_a = seasonsDoc(".dropdown-item").toArray().find((el) => seasonsDoc(el).text() === `Season ${media.season.number}`)) == null ? void 0 : _a.attribs["data-id"];
  if (!season)
    throw new NotFoundError("season not found");
  const seasonData = await ctx.proxiedFetcher(`/ajax/season/episodes/${season}`, {
    baseUrl: flixHqBase
  });
  const seasonDoc = load(seasonData);
  const episode = (_b = seasonDoc(".nav-item > a").toArray().map((el) => {
    return {
      id: seasonDoc(el).attr("data-id"),
      title: seasonDoc(el).attr("title")
    };
  }).find((e) => {
    var _a2;
    return (_a2 = e.title) == null ? void 0 : _a2.startsWith(`Eps ${media.episode.number}`);
  })) == null ? void 0 : _b.id;
  if (!episode)
    throw new NotFoundError("episode not found");
  const data = await ctx.proxiedFetcher(`/ajax/episode/servers/${episode}`, {
    baseUrl: flixHqBase
  });
  const doc = load(data);
  const sourceLinks = doc(".nav-item > a").toArray().map((el) => {
    const query = doc(el);
    const embedTitle = query.attr("title");
    const linkId = query.attr("data-id");
    if (!embedTitle || !linkId)
      throw new Error("invalid sources");
    return {
      embed: embedTitle,
      episodeId: linkId
    };
  });
  return sourceLinks;
}
function normalizeTitle(title) {
  return title.trim().toLowerCase().replace(/['":]/g, "").replace(/[^a-zA-Z0-9]+/g, "_");
}
function compareTitle(a, b) {
  return normalizeTitle(a) === normalizeTitle(b);
}
function compareMedia(media, title, releaseYear) {
  const isSameYear = releaseYear === void 0 ? true : media.releaseYear === releaseYear;
  return compareTitle(media.title, title) && isSameYear;
}
async function getFlixhqId(ctx, media) {
  const searchResults = await ctx.proxiedFetcher(`/search/${media.title.replaceAll(/[^a-z0-9A-Z]/g, "-")}`, {
    baseUrl: flixHqBase
  });
  const doc = load(searchResults);
  const items = doc(".film_list-wrap > div.flw-item").toArray().map((el) => {
    var _a;
    const query = doc(el);
    const id = (_a = query.find("div.film-poster > a").attr("href")) == null ? void 0 : _a.slice(1);
    const title = query.find("div.film-detail > h2 > a").attr("title");
    const year = query.find("div.film-detail > div.fd-infor > span:nth-child(1)").text();
    if (!id || !title || !year)
      return null;
    return {
      id,
      title,
      year: parseInt(year, 10)
    };
  });
  const matchingItem = items.find((v) => v && compareMedia(media, v.title, v.year));
  if (!matchingItem)
    return null;
  return matchingItem.id;
}
const flixhqScraper = makeSourcerer({
  id: "flixhq",
  name: "FlixHQ",
  rank: 100,
  flags: [flags.NO_CORS],
  async scrapeMovie(ctx) {
    const id = await getFlixhqId(ctx, ctx.media);
    if (!id)
      throw new NotFoundError("no search results match");
    const sources = await getFlixhqMovieSources(ctx, ctx.media, id);
    const upcloudStream = sources.find((v) => v.embed.toLowerCase() === "upcloud");
    if (!upcloudStream)
      throw new NotFoundError("upcloud stream not found for flixhq");
    return {
      embeds: [
        {
          embedId: upcloudScraper.id,
          url: await getFlixhqSourceDetails(ctx, upcloudStream.episodeId)
        }
      ]
    };
  },
  async scrapeShow(ctx) {
    const id = await getFlixhqId(ctx, ctx.media);
    if (!id)
      throw new NotFoundError("no search results match");
    const sources = await getFlixhqShowSources(ctx, ctx.media, id);
    const upcloudStream = sources.find((v) => v.embed.toLowerCase() === "server upcloud");
    if (!upcloudStream)
      throw new NotFoundError("upcloud stream not found for flixhq");
    return {
      embeds: [
        {
          embedId: upcloudScraper.id,
          url: await getFlixhqSourceDetails(ctx, upcloudStream.episodeId)
        }
      ]
    };
  }
});
async function getSource(ctx, sources) {
  const upcloud = load(sources)('a[title*="upcloud" i]');
  const upcloudDataId = (upcloud == null ? void 0 : upcloud.attr("data-id")) ?? (upcloud == null ? void 0 : upcloud.attr("data-linkid"));
  if (!upcloudDataId)
    throw new NotFoundError("Upcloud source not available");
  const upcloudSource = await ctx.proxiedFetcher(`/ajax/sources/${upcloudDataId}`, {
    headers: {
      "X-Requested-With": "XMLHttpRequest"
    },
    baseUrl: gomoviesBase
  });
  if (!upcloudSource.link || upcloudSource.type !== "iframe")
    throw new NotFoundError("No upcloud stream found");
  return upcloudSource;
}
const gomoviesBase = `https://gomovies.sx`;
const goMoviesScraper = makeSourcerer({
  id: "gomovies",
  name: "GOmovies",
  rank: 200,
  flags: [flags.NO_CORS],
  async scrapeShow(ctx) {
    var _a;
    const search2 = await ctx.proxiedFetcher(`/ajax/search`, {
      method: "POST",
      body: new URLSearchParams({ keyword: ctx.media.title }),
      headers: {
        "X-Requested-With": "XMLHttpRequest"
      },
      baseUrl: gomoviesBase
    });
    const searchPage = load(search2);
    const mediaElements = searchPage("a.nav-item");
    const mediaData = mediaElements.toArray().map((movieEl) => {
      var _a2, _b;
      const name = (_a2 = searchPage(movieEl).find("h3.film-name")) == null ? void 0 : _a2.text();
      const year = (_b = searchPage(movieEl).find("div.film-infor span:first-of-type")) == null ? void 0 : _b.text();
      const path = searchPage(movieEl).attr("href");
      return { name, year, path };
    });
    const targetMedia = mediaData.find((m) => m.name === ctx.media.title);
    if (!(targetMedia == null ? void 0 : targetMedia.path))
      throw new NotFoundError("Media not found");
    let mediaId = (_a = targetMedia.path.split("-").pop()) == null ? void 0 : _a.replace("/", "");
    const seasons = await ctx.proxiedFetcher(`/ajax/v2/tv/seasons/${mediaId}`, {
      headers: {
        "X-Requested-With": "XMLHttpRequest"
      },
      baseUrl: gomoviesBase
    });
    const seasonsEl = load(seasons)(".ss-item");
    const seasonsData = seasonsEl.toArray().map((season) => ({
      number: load(season).text().replace("Season ", ""),
      dataId: season.attribs["data-id"]
    }));
    const seasonNumber = ctx.media.season.number;
    const targetSeason = seasonsData.find((season) => +season.number === seasonNumber);
    if (!targetSeason)
      throw new NotFoundError("Season not found");
    const episodes = await ctx.proxiedFetcher(`/ajax/v2/season/episodes/${targetSeason.dataId}`, {
      headers: {
        "X-Requested-With": "XMLHttpRequest"
      },
      baseUrl: gomoviesBase
    });
    const episodesPage = load(episodes);
    const episodesEl = episodesPage(".eps-item");
    const episodesData = episodesEl.toArray().map((ep) => ({
      dataId: ep.attribs["data-id"],
      number: episodesPage(ep).find("strong").text().replace("Eps", "").replace(":", "").trim()
    }));
    const episodeNumber = ctx.media.episode.number;
    const targetEpisode = episodesData.find((ep) => ep.number ? +ep.number === episodeNumber : false);
    if (!(targetEpisode == null ? void 0 : targetEpisode.dataId))
      throw new NotFoundError("Episode not found");
    mediaId = targetEpisode.dataId;
    const sources = await ctx.proxiedFetcher(`ajax/v2/episode/servers/${mediaId}`, {
      baseUrl: gomoviesBase,
      headers: {
        "X-Requested-With": "XMLHttpRequest"
      }
    });
    const upcloudSource = await getSource(ctx, sources);
    return {
      embeds: [
        {
          embedId: upcloudScraper.id,
          url: upcloudSource.link
        }
      ]
    };
  },
  async scrapeMovie(ctx) {
    var _a;
    const search2 = await ctx.proxiedFetcher(`ajax/search`, {
      method: "POST",
      body: new URLSearchParams({ keyword: ctx.media.title }),
      headers: {
        "X-Requested-With": "XMLHttpRequest"
      },
      baseUrl: gomoviesBase
    });
    const searchPage = load(search2);
    const mediaElements = searchPage("a.nav-item");
    const mediaData = mediaElements.toArray().map((movieEl) => {
      var _a2, _b;
      const name = (_a2 = searchPage(movieEl).find("h3.film-name")) == null ? void 0 : _a2.text();
      const year = (_b = searchPage(movieEl).find("div.film-infor span:first-of-type")) == null ? void 0 : _b.text();
      const path = searchPage(movieEl).attr("href");
      return { name, year, path };
    });
    const targetMedia = mediaData.find(
      (m) => m.name === ctx.media.title && m.year === ctx.media.releaseYear.toString()
    );
    if (!(targetMedia == null ? void 0 : targetMedia.path))
      throw new NotFoundError("Media not found");
    const mediaId = (_a = targetMedia.path.split("-").pop()) == null ? void 0 : _a.replace("/", "");
    const sources = await ctx.proxiedFetcher(`ajax/movie/episodes/${mediaId}`, {
      headers: {
        "X-Requested-With": "XMLHttpRequest"
      },
      baseUrl: gomoviesBase
    });
    const upcloudSource = await getSource(ctx, sources);
    return {
      embeds: [
        {
          embedId: upcloudScraper.id,
          url: upcloudSource.link
        }
      ]
    };
  }
});
const kissasianBase = "https://kissasian.sh";
const embedProviders = [
  {
    type: mp4uploadScraper.id,
    id: "mp"
  },
  {
    type: streamsbScraper.id,
    id: "sb"
  }
];
async function getEmbeds(ctx, targetEpisode) {
  let embeds = await Promise.all(
    embedProviders.map(async (provider) => {
      if (!targetEpisode.url)
        throw new NotFoundError("Episode not found");
      const watch = await ctx.proxiedFetcher(`${targetEpisode.url}&s=${provider.id}`, {
        baseUrl: kissasianBase,
        headers: {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
          "accept-language": "en-US,en;q=0.9",
          "cache-control": "no-cache",
          pragma: "no-cache",
          "sec-ch-ua": '"Not)A;Brand";v="24", "Chromium";v="116"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"macOS"',
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "cross-site",
          "sec-fetch-user": "?1",
          "upgrade-insecure-requests": "1",
          cookie: "__rd=; ASP.NET_SessionId=jwnl2kmlw5h4mfdaxvpk30q0; k_token=OKbJDFNx3rUtaw7iAA6UxMKSJb79lgZ2X2rVC9aupJhycYQKVSLaW1y2B4K%2f%2fo3i6BuzhXgfkJGmKlKH6LpNlKPPpZUk31n9DapfMdJgjlLExgrPS3jpSKwGnNUI%2bOpNpZu9%2fFnkLZRxvVKCa8APMxrck1tYkKXWqfyJJh8%2b7hQTI1wfAOU%2fLEouHhtQGL%2fReTzElw2LQ0XSL1pjs%2fkWW3rM3of2je7Oo13I%2f7olLFuiJUVWyNbn%2fYKSgNrm%2bQ3p"
        }
      });
      const watchPage = load(watch);
      const embedUrl = watchPage("#my_video_1").attr("src");
      if (!embedUrl)
        throw new Error("Embed not found");
      return {
        embedId: provider.id,
        url: embedUrl
      };
    })
  );
  embeds = embeds.filter((e) => !!e.url);
  return embeds;
}
function getEpisodes(dramaPage) {
  const episodesEl = dramaPage(".episodeSub");
  return episodesEl.toArray().map((ep) => {
    var _a;
    const number = (_a = dramaPage(ep).find(".episodeSub a").text().split("Episode")[1]) == null ? void 0 : _a.trim();
    const url = dramaPage(ep).find(".episodeSub a").attr("href");
    return { number, url };
  }).filter((e) => !!e.url);
}
async function search(ctx, title, seasonNumber) {
  const searchForm = new FormData();
  searchForm.append("keyword", `${title} ${seasonNumber ?? ""}`.trim());
  searchForm.append("type", "Drama");
  const searchResults = await ctx.proxiedFetcher("/Search/SearchSuggest", {
    baseUrl: kissasianBase,
    method: "POST",
    body: searchForm
  });
  const searchPage = load(searchResults);
  return Array.from(searchPage("a")).map((drama) => {
    return {
      name: searchPage(drama).text(),
      url: drama.attribs.href
    };
  });
}
const kissAsianScraper = makeSourcerer({
  id: "kissasian",
  name: "KissAsian",
  rank: 130,
  flags: [flags.NO_CORS],
  disabled: true,
  async scrapeShow(ctx) {
    const seasonNumber = ctx.media.season.number;
    const episodeNumber = ctx.media.episode.number;
    const dramas = await search(ctx, ctx.media.title, seasonNumber);
    const targetDrama = dramas.find((d) => {
      var _a;
      return ((_a = d.name) == null ? void 0 : _a.toLowerCase()) === ctx.media.title.toLowerCase();
    }) ?? dramas[0];
    if (!targetDrama)
      throw new NotFoundError("Drama not found");
    ctx.progress(30);
    const drama = await ctx.proxiedFetcher(targetDrama.url, {
      baseUrl: kissasianBase
    });
    const dramaPage = load(drama);
    const episodes = await getEpisodes(dramaPage);
    const targetEpisode = episodes.find((e) => e.number === `${episodeNumber}`);
    if (!(targetEpisode == null ? void 0 : targetEpisode.url))
      throw new NotFoundError("Episode not found");
    ctx.progress(70);
    const embeds = await getEmbeds(ctx, targetEpisode);
    return {
      embeds
    };
  },
  async scrapeMovie(ctx) {
    const dramas = await search(ctx, ctx.media.title, void 0);
    const targetDrama = dramas.find((d) => {
      var _a;
      return ((_a = d.name) == null ? void 0 : _a.toLowerCase()) === ctx.media.title.toLowerCase();
    }) ?? dramas[0];
    if (!targetDrama)
      throw new NotFoundError("Drama not found");
    ctx.progress(30);
    const drama = await ctx.proxiedFetcher(targetDrama.url, {
      baseUrl: kissasianBase
    });
    const dramaPage = load(drama);
    const episodes = getEpisodes(dramaPage);
    const targetEpisode = episodes[0];
    if (!(targetEpisode == null ? void 0 : targetEpisode.url))
      throw new NotFoundError("Episode not found");
    ctx.progress(70);
    const embeds = await getEmbeds(ctx, targetEpisode);
    return {
      embeds
    };
  }
});
const remotestreamBase = `https://fsa.remotestre.am`;
const remotestreamScraper = makeSourcerer({
  id: "remotestream",
  name: "Remote Stream",
  rank: 55,
  flags: [flags.NO_CORS],
  async scrapeShow(ctx) {
    const seasonNumber = ctx.media.season.number;
    const episodeNumber = ctx.media.episode.number;
    const playlistLink = `${remotestreamBase}/Shows/${ctx.media.tmdbId}/${seasonNumber}/${episodeNumber}/${episodeNumber}.m3u8`;
    ctx.progress(30);
    const streamRes = await ctx.fetcher(playlistLink);
    if (streamRes.type !== "application/x-mpegurl")
      throw new NotFoundError("No watchable item found");
    ctx.progress(90);
    return {
      embeds: [],
      stream: {
        captions: [],
        playlist: playlistLink,
        type: "hls",
        flags: [flags.NO_CORS]
      }
    };
  },
  async scrapeMovie(ctx) {
    const playlistLink = `${remotestreamBase}/Movies/${ctx.media.tmdbId}/${ctx.media.tmdbId}.m3u8`;
    ctx.progress(30);
    const streamRes = await ctx.fetcher(playlistLink);
    if (streamRes.type !== "application/x-mpegurl")
      throw new NotFoundError("No watchable item found");
    ctx.progress(90);
    return {
      embeds: [],
      stream: {
        captions: [],
        playlist: playlistLink,
        type: "hls",
        flags: [flags.NO_CORS]
      }
    };
  }
});
const iv = atob("d0VpcGhUbiE=");
const key = atob("MTIzZDZjZWRmNjI2ZHk1NDIzM2FhMXc2");
const apiUrls = [
  atob("aHR0cHM6Ly9zaG93Ym94LnNoZWd1Lm5ldC9hcGkvYXBpX2NsaWVudC9pbmRleC8="),
  atob("aHR0cHM6Ly9tYnBhcGkuc2hlZ3UubmV0L2FwaS9hcGlfY2xpZW50L2luZGV4Lw==")
];
const appKey = atob("bW92aWVib3g=");
const appId = atob("Y29tLnRkby5zaG93Ym94");
function encrypt(str) {
  return CryptoJS.TripleDES.encrypt(str, CryptoJS.enc.Utf8.parse(key), {
    iv: CryptoJS.enc.Utf8.parse(iv)
  }).toString();
}
function getVerify(str, str2, str3) {
  if (str) {
    return CryptoJS.MD5(CryptoJS.MD5(str2).toString() + str3 + str).toString();
  }
  return null;
}
const randomId = customAlphabet("1234567890abcdef");
const expiry = () => Math.floor(Date.now() / 1e3 + 60 * 60 * 12);
const sendRequest = async (ctx, data, altApi = false) => {
  const defaultData = {
    childmode: "0",
    app_version: "11.5",
    appid: appId,
    lang: "en",
    expired_date: `${expiry()}`,
    platform: "android",
    channel: "Website"
  };
  const encryptedData = encrypt(
    JSON.stringify({
      ...defaultData,
      ...data
    })
  );
  const appKeyHash = CryptoJS.MD5(appKey).toString();
  const verify = getVerify(encryptedData, appKey, key);
  const body = JSON.stringify({
    app_key: appKeyHash,
    verify,
    encrypt_data: encryptedData
  });
  const base64body = btoa(body);
  const formatted = new URLSearchParams();
  formatted.append("data", base64body);
  formatted.append("appid", "27");
  formatted.append("platform", "android");
  formatted.append("version", "129");
  formatted.append("medium", "Website");
  formatted.append("token", randomId(32));
  const requestUrl = altApi ? apiUrls[1] : apiUrls[0];
  const response = await ctx.proxiedFetcher(requestUrl, {
    method: "POST",
    headers: {
      Platform: "android",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: formatted
  });
  return JSON.parse(response);
};
async function getSubtitles(ctx, id, fid, type, episodeId, seasonId) {
  const module = type === "movie" ? "Movie_srt_list_v2" : "TV_srt_list_v2";
  const subtitleApiQuery = {
    fid,
    uid: "",
    module,
    mid: type === "movie" ? id : void 0,
    tid: type !== "movie" ? id : void 0,
    episode: episodeId == null ? void 0 : episodeId.toString(),
    season: seasonId == null ? void 0 : seasonId.toString(),
    group: episodeId ? "" : void 0
  };
  const subtitleList = (await sendRequest(ctx, subtitleApiQuery)).data.list;
  const output = [];
  subtitleList.forEach((sub) => {
    const subtitle = sub.subtitles.sort((a, b) => b.order - a.order)[0];
    if (!subtitle)
      return;
    const subtitleType = getCaptionTypeFromUrl(subtitle.file_path);
    if (!subtitleType)
      return;
    const validCode = isValidLanguageCode(subtitle.lang);
    if (!validCode)
      return;
    output.push({
      language: subtitle.lang,
      hasCorsRestrictions: true,
      type: subtitleType,
      url: subtitle.file_path
    });
  });
  return output;
}
const allowedQualities = ["360", "480", "720", "1080"];
async function getStreamQualities(ctx, apiQuery) {
  var _a;
  const mediaRes = (await sendRequest(ctx, apiQuery)).data;
  ctx.progress(66);
  const qualityMap = mediaRes.list.filter((file) => allowedQualities.includes(file.quality.replace("p", ""))).map((file) => ({
    url: file.path,
    quality: file.quality.replace("p", "")
  }));
  const qualities = {};
  allowedQualities.forEach((quality) => {
    const foundQuality = qualityMap.find((q) => q.quality === quality);
    if (foundQuality && foundQuality.url) {
      qualities[quality] = {
        type: "mp4",
        url: foundQuality.url
      };
    }
  });
  return {
    qualities,
    fid: (_a = mediaRes.list[0]) == null ? void 0 : _a.fid
  };
}
const superStreamScraper = makeSourcerer({
  id: "superstream",
  name: "Superstream",
  rank: 300,
  flags: [flags.NO_CORS],
  async scrapeShow(ctx) {
    const searchQuery = {
      module: "Search4",
      page: "1",
      type: "all",
      keyword: ctx.media.title,
      pagelimit: "20"
    };
    const searchRes = (await sendRequest(ctx, searchQuery, true)).data.list;
    ctx.progress(33);
    const superstreamEntry = searchRes.find(
      (res) => compareTitle(res.title, ctx.media.title) && res.year === Number(ctx.media.releaseYear)
    );
    if (!superstreamEntry)
      throw new NotFoundError("No entry found");
    const superstreamId = superstreamEntry.id;
    const apiQuery = {
      uid: "",
      module: "TV_downloadurl_v3",
      tid: superstreamId,
      season: ctx.media.season.number,
      episode: ctx.media.episode.number,
      oss: "1",
      group: ""
    };
    const { qualities, fid } = await getStreamQualities(ctx, apiQuery);
    return {
      embeds: [],
      stream: {
        captions: await getSubtitles(
          ctx,
          superstreamId,
          fid,
          "show",
          ctx.media.episode.number,
          ctx.media.season.number
        ),
        qualities,
        type: "file",
        flags: [flags.NO_CORS]
      }
    };
  },
  async scrapeMovie(ctx) {
    const searchQuery = {
      module: "Search4",
      page: "1",
      type: "all",
      keyword: ctx.media.title,
      pagelimit: "20"
    };
    const searchRes = (await sendRequest(ctx, searchQuery, true)).data.list;
    ctx.progress(33);
    const superstreamEntry = searchRes.find(
      (res) => compareTitle(res.title, ctx.media.title) && res.year === Number(ctx.media.releaseYear)
    );
    if (!superstreamEntry)
      throw new NotFoundError("No entry found");
    const superstreamId = superstreamEntry.id;
    const apiQuery = {
      uid: "",
      module: "Movie_downloadurl_v3",
      mid: superstreamId,
      oss: "1",
      group: ""
    };
    const { qualities, fid } = await getStreamQualities(ctx, apiQuery);
    return {
      embeds: [],
      stream: {
        captions: await getSubtitles(ctx, superstreamId, fid, "movie"),
        qualities,
        type: "file",
        flags: [flags.NO_CORS]
      }
    };
  }
});
async function getZoeChipSources(ctx, id) {
  const endpoint = ctx.media.type === "movie" ? "list" : "servers";
  const html = await ctx.proxiedFetcher(`/ajax/episode/${endpoint}/${id}`, {
    baseUrl: zoeBase
  });
  const $ = load(html);
  return $(".nav-item a").toArray().map((el) => {
    const idAttribute = ctx.media.type === "movie" ? "data-linkid" : "data-id";
    const element = $(el);
    const embedTitle = element.attr("title");
    const linkId = element.attr(idAttribute);
    if (!embedTitle || !linkId) {
      throw new Error("invalid sources");
    }
    return {
      embed: embedTitle,
      episodeId: linkId
    };
  });
}
async function getZoeChipSourceURL(ctx, sourceID) {
  const details = await ctx.proxiedFetcher(`/ajax/sources/${sourceID}`, {
    baseUrl: zoeBase
  });
  if (details.type !== "iframe") {
    return null;
  }
  return details.link;
}
async function getZoeChipSeasonID(ctx, media, showID) {
  const html = await ctx.proxiedFetcher(`/ajax/season/list/${showID}`, {
    baseUrl: zoeBase
  });
  const $ = load(html);
  const seasons = $(".dropdown-menu a").toArray().map((el) => {
    var _a;
    const element = $(el);
    const seasonID = element.attr("data-id");
    const seasonNumber = (_a = element.html()) == null ? void 0 : _a.split(" ")[1];
    if (!seasonID || !seasonNumber || Number.isNaN(Number(seasonNumber))) {
      throw new Error("invalid season");
    }
    return {
      id: seasonID,
      season: Number(seasonNumber)
    };
  });
  const foundSeason = seasons.find((season) => season.season === media.season.number);
  if (!foundSeason) {
    return null;
  }
  return foundSeason.id;
}
async function getZoeChipEpisodeID(ctx, media, seasonID) {
  const episodeNumberRegex = /Eps (\d*):/;
  const html = await ctx.proxiedFetcher(`/ajax/season/episodes/${seasonID}`, {
    baseUrl: zoeBase
  });
  const $ = load(html);
  const episodes = $(".eps-item").toArray().map((el) => {
    const element = $(el);
    const episodeID = element.attr("data-id");
    const title = element.attr("title");
    if (!episodeID || !title) {
      throw new Error("invalid episode");
    }
    const regexResult = title.match(episodeNumberRegex);
    if (!regexResult || Number.isNaN(Number(regexResult[1]))) {
      throw new Error("invalid episode");
    }
    return {
      id: episodeID,
      episode: Number(regexResult[1])
    };
  });
  const foundEpisode = episodes.find((episode) => episode.episode === media.episode.number);
  if (!foundEpisode) {
    return null;
  }
  return foundEpisode.id;
}
const zoeBase = "https://zoechip.cc";
async function formatSource(ctx, source) {
  const link = await getZoeChipSourceURL(ctx, source.episodeId);
  if (link) {
    const embed = {
      embedId: "",
      url: link
    };
    const parsedUrl = new URL(link);
    switch (parsedUrl.host) {
      case "rabbitstream.net":
        embed.embedId = upcloudScraper.id;
        break;
      case "upstream.to":
        embed.embedId = upstreamScraper.id;
        break;
      case "mixdrop.co":
        embed.embedId = mixdropScraper.id;
        break;
      default:
        throw new Error(`Failed to find ZoeChip embed source for ${link}`);
    }
    return embed;
  }
}
async function createZoeChipStreamData(ctx, id) {
  const sources = await getZoeChipSources(ctx, id);
  const embeds = [];
  for (const source of sources) {
    const formatted = await formatSource(ctx, source);
    if (formatted) {
      embeds.push(formatted);
    }
  }
  return {
    embeds
  };
}
async function getZoeChipSearchResults(ctx, media) {
  const titleCleaned = media.title.toLocaleLowerCase().replace(/ /g, "-");
  const html = await ctx.proxiedFetcher(`/search/${titleCleaned}`, {
    baseUrl: zoeBase
  });
  const $ = load(html);
  return $(".film_list-wrap .flw-item .film-detail").toArray().map((element) => {
    const movie = $(element);
    const anchor = movie.find(".film-name a");
    const info = movie.find(".fd-infor");
    const title = anchor.attr("title");
    const href = anchor.attr("href");
    const type = info.find(".fdi-type").html();
    let year = info.find(".fdi-item").html();
    const id = href == null ? void 0 : href.split("-").pop();
    if (!title) {
      return null;
    }
    if (!href) {
      return null;
    }
    if (!type) {
      return null;
    }
    if (!year || Number.isNaN(Number(year))) {
      if (type === "TV") {
        year = "0";
      } else {
        return null;
      }
    }
    if (!id) {
      return null;
    }
    return {
      title,
      year: Number(year),
      id,
      type,
      href
    };
  });
}
async function getZoeChipMovieID(ctx, media) {
  const searchResults = await getZoeChipSearchResults(ctx, media);
  const matchingItem = searchResults.find((v) => v && v.type === "Movie" && compareMedia(media, v.title, v.year));
  if (!matchingItem) {
    return null;
  }
  return matchingItem.id;
}
async function getZoeChipShowID(ctx, media) {
  const releasedRegex = /<\/strong><\/span> (\d.*)-\d.*-\d.*/;
  const searchResults = await getZoeChipSearchResults(ctx, media);
  const filtered = searchResults.filter((v) => v && v.type === "TV" && compareMedia(media, v.title));
  for (const result of filtered) {
    if (!result) {
      continue;
    }
    const html = await ctx.proxiedFetcher(result.href, {
      baseUrl: zoeBase
    });
    const regexResult = html.match(releasedRegex);
    if (regexResult) {
      const year = Number(regexResult[1]);
      if (!Number.isNaN(year) && compareMedia(media, result.title, year)) {
        return result.id;
      }
    }
  }
  return null;
}
async function scrapeMovie(ctx) {
  const movieID = await getZoeChipMovieID(ctx, ctx.media);
  if (!movieID) {
    throw new NotFoundError("no search results match");
  }
  return createZoeChipStreamData(ctx, movieID);
}
async function scrapeShow(ctx) {
  const showID = await getZoeChipShowID(ctx, ctx.media);
  if (!showID) {
    throw new NotFoundError("no search results match");
  }
  const seasonID = await getZoeChipSeasonID(ctx, ctx.media, showID);
  if (!seasonID) {
    throw new NotFoundError("no season found");
  }
  const episodeID = await getZoeChipEpisodeID(ctx, ctx.media, seasonID);
  if (!episodeID) {
    throw new NotFoundError("no episode found");
  }
  return createZoeChipStreamData(ctx, episodeID);
}
const zoechipScraper = makeSourcerer({
  id: "zoechip",
  name: "ZoeChip",
  rank: 110,
  flags: [flags.NO_CORS],
  scrapeMovie,
  scrapeShow
});
const showboxBase = `https://www.showbox.media`;
const showBoxScraper = makeSourcerer({
  id: "show_box",
  name: "ShowBox",
  rank: 20,
  flags: [flags.NO_CORS],
  async scrapeMovie(ctx) {
    var _a;
    const search2 = await ctx.proxiedFetcher("/search", {
      baseUrl: showboxBase,
      query: {
        keyword: ctx.media.title
      }
    });
    const searchPage = load(search2);
    const result = searchPage(".film-name > a").toArray().map((el) => {
      var _a2;
      const titleContainer = (_a2 = el.parent) == null ? void 0 : _a2.parent;
      if (!titleContainer)
        return;
      const year = searchPage(titleContainer).find(".fdi-item").first().text();
      return {
        title: el.attribs.title,
        path: el.attribs.href,
        year: !year.includes("SS") ? parseInt(year, 10) : void 0
      };
    }).find((v) => v && compareMedia(ctx.media, v.title, v.year ? v.year : void 0));
    if (!(result == null ? void 0 : result.path))
      throw new NotFoundError("no result found");
    const febboxResult = await ctx.proxiedFetcher("/index/share_link", {
      baseUrl: showboxBase,
      query: {
        id: result.path.split("/")[3],
        type: "1"
      }
    });
    if (!((_a = febboxResult == null ? void 0 : febboxResult.data) == null ? void 0 : _a.link))
      throw new NotFoundError("no result found");
    return {
      embeds: [
        {
          embedId: febBoxScraper.id,
          url: febboxResult.data.link
        }
      ]
    };
  }
});
function gatherAllSources() {
  return [
    flixhqScraper,
    remotestreamScraper,
    kissAsianScraper,
    superStreamScraper,
    goMoviesScraper,
    zoechipScraper,
    showBoxScraper
  ];
}
function gatherAllEmbeds() {
  return [upcloudScraper, mp4uploadScraper, streamsbScraper, upstreamScraper, febBoxScraper, mixdropScraper];
}
function hasDuplicates(values) {
  return new Set(values).size !== values.length;
}
function getProviders(features) {
  const sources = gatherAllSources().filter((v) => !(v == null ? void 0 : v.disabled));
  const embeds = gatherAllEmbeds().filter((v) => !(v == null ? void 0 : v.disabled));
  const combined = [...sources, ...embeds];
  const anyDuplicateId = hasDuplicates(combined.map((v) => v.id));
  const anyDuplicateSourceRank = hasDuplicates(sources.map((v) => v.rank));
  const anyDuplicateEmbedRank = hasDuplicates(embeds.map((v) => v.rank));
  if (anyDuplicateId)
    throw new Error("Duplicate id found in sources/embeds");
  if (anyDuplicateSourceRank)
    throw new Error("Duplicate rank found in sources");
  if (anyDuplicateEmbedRank)
    throw new Error("Duplicate rank found in embeds");
  return {
    sources: sources.filter((s) => flagsAllowedInFeatures(features, s.flags)),
    embeds
  };
}
function makeProviders(ops) {
  const features = getTargetFeatures(ops.target);
  const list = getProviders(features);
  const providerRunnerOps = {
    features,
    fetcher: makeFullFetcher(ops.fetcher),
    proxiedFetcher: makeFullFetcher(ops.proxiedFetcher ?? ops.fetcher)
  };
  return {
    runAll(runnerOps) {
      return runAllProviders(list, {
        ...providerRunnerOps,
        ...runnerOps
      });
    },
    runSourceScraper(runnerOps) {
      return scrapeInvidualSource(list, {
        ...providerRunnerOps,
        ...runnerOps
      });
    },
    runEmbedScraper(runnerOps) {
      return scrapeIndividualEmbed(list, {
        ...providerRunnerOps,
        ...runnerOps
      });
    },
    getMetadata(id) {
      return getSpecificId(list, id);
    },
    listSources() {
      return getAllSourceMetaSorted(list);
    },
    listEmbeds() {
      return getAllEmbedMetaSorted(list);
    }
  };
}
function serializeBody(body) {
  if (body === void 0 || typeof body === "string" || body instanceof URLSearchParams || body instanceof FormData)
    return {
      headers: {},
      body
    };
  return {
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  };
}
function makeStandardFetcher(f) {
  const normalFetch = async (url, ops) => {
    var _a;
    const fullUrl = makeFullUrl(url, ops);
    const seralizedBody = serializeBody(ops.body);
    const res = await f(fullUrl, {
      method: ops.method,
      headers: {
        ...seralizedBody.headers,
        ...ops.headers
      },
      body: seralizedBody.body
    });
    const isJson = (_a = res.headers.get("content-type")) == null ? void 0 : _a.includes("application/json");
    if (isJson)
      return res.json();
    return res.text();
  };
  return normalFetch;
}
const headerMap = {
  cookie: "X-Cookie",
  referer: "X-Referer",
  origin: "X-Origin"
};
function makeSimpleProxyFetcher(proxyUrl, f) {
  const fetcher = makeStandardFetcher(f);
  const proxiedFetch = async (url, ops) => {
    const fullUrl = makeFullUrl(url, ops);
    const headerEntries = Object.entries(ops.headers).map((entry) => {
      const key2 = entry[0].toLowerCase();
      if (headerMap[key2])
        return [headerMap[key2], entry[1]];
      return entry;
    });
    return fetcher(proxyUrl, {
      ...ops,
      query: {
        destination: fullUrl
      },
      headers: Object.fromEntries(headerEntries),
      baseUrl: void 0
    });
  };
  return proxiedFetch;
}
export {
  NotFoundError,
  flags,
  makeProviders,
  makeSimpleProxyFetcher,
  makeStandardFetcher,
  targets
};
