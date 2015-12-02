!function(e){if("object"==typeof exports&&"undefined"!=typeof module)module.exports=e();else if("function"==typeof define&&define.amd)define([],e);else{var f;"undefined"!=typeof window?f=window:"undefined"!=typeof global?f=global:"undefined"!=typeof self&&(f=self),f.List=e()}}(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);throw new Error("Cannot find module '"+o+"'")}var f=n[o]={exports:{}};t[o][0].call(f.exports,function(e){var n=t[o][1][e];return s(n?n:e)},f,f.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(_dereq_,module,exports){
/*
  Copyright 2013-2014, Marten de Vries

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

  http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

"use strict";

var extend = _dereq_("extend");
var render = _dereq_("couchdb-render");
var PouchPluginError = _dereq_("pouchdb-plugin-error");

exports.list = function (listPath, options, callback) {
  //options: values to end up in the request object of the list
  //function (next to their defaults).
  var db = this;

  if (["function", "undefined"].indexOf(typeof options) !== -1) {
    callback = options;
    options = {};
  }
  var designDocName = listPath.split("/")[0];
  var listName = listPath.split("/")[1];
  var viewName = listPath.split("/")[2];

  //build request object
  var pathEnd = ["_design", designDocName, "_list", listName];
  if (viewName) {
    pathEnd.push(viewName);
  }

  if (["http", "https"].indexOf(db.type()) === -1) {
    return offlineQuery(db, designDocName, listName, viewName, options);
  } else {
    return db.request({
      method: 'GET',
      url: pathEnd.join('/')
    });
  }
};

function offlineQuery(db, designDocName, listName, viewName, options) {
  //get the data involved.
  var ddocPromise = db.get("_design/" + designDocName).then(function (designDoc) {
    if (!(designDoc.lists || {}).hasOwnProperty(listName)) {
      throw new PouchPluginError({
        status: 404,
        name: "not_found",
        message: "missing list function " + listName + " on design doc _design/" + designDocName
      });
    }
    return designDoc;
  });
  var viewOpts = extend({}, options.query);
  var viewPromise = db.query(designDocName + "/" + viewName, viewOpts);

  //not Promise.all because the error order matters.
  var args = [];
  return viewPromise.then(function (viewResp) {
    args.push(viewResp);

    return db.info();
  }).then(function (info) {
    args.push(info);

    return ddocPromise;
  }).then(function (ddoc) {
    args.push(ddoc);

    return args;

  }).then(Function.prototype.apply.bind(function (viewResp, info, designDoc) {
    var head = {
      offset: viewResp.offset,
      total_rows: viewResp.total_rows,
      update_seq: info.update_seq
    };

    var respInfo;
    var chunks = [];

    var listApi = {
      getRow: function () {
        return viewResp.rows.shift() || null;
      },
      send: function (chunk) {
        listApi.start({});
        chunks.push(chunk);
      },
      start: function (respBegin) {
        if (!respInfo) {
          respInfo = respBegin;
        }
      }
    };

     // fake request object
    var req = {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      query: {}
    };
    var resp = render(designDoc.lists[listName], designDoc, head, req, listApi);
    if (respInfo) {
      extend(resp, respInfo);
      resp.body = chunks.join("") + resp.body;
      resp.headers["Transfer-Encoding"] = "chunked";
    }
    return resp;
  }, null));
}

},{"couchdb-render":2,"extend":6,"pouchdb-plugin-error":7}],2:[function(_dereq_,module,exports){
/*
	Copyright 2013-2014, Marten de Vries

	Licensed under the Apache License, Version 2.0 (the "License");
	you may not use this file except in compliance with the License.
	You may obtain a copy of the License at

	http://www.apache.org/licenses/LICENSE-2.0

	Unless required by applicable law or agreed to in writing, software
	distributed under the License is distributed on an "AS IS" BASIS,
	WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
	See the License for the specific language governing permissions and
	limitations under the License.
*/

"use strict";

var extend = _dereq_("extend");
var isEmpty = _dereq_("is-empty");

var coucheval = _dereq_("couchdb-eval");
var completeRespObj = _dereq_("couchdb-resp-completer");
var PouchPluginError = _dereq_("pouchdb-plugin-error");

function isObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

module.exports = function render(source, designDoc, data, req, extraVars) {
  /*jshint evil: true */
  if (!extraVars) {
    extraVars = {};
  }
  var providesCtx = buildProvidesCtx();
  extend(extraVars, providesCtx.api);
  var func = coucheval.evaluate(designDoc, extraVars, source);

  var result, contentType;
  try {
    result = func.call(designDoc, data, req);
  } catch (e) {
    throw coucheval.wrapExecutionError(e);
  }
  if (!(typeof result === "string" || isObject(result))) {
    var resp = providesCtx.getResult(req);
    result = resp[0];
    contentType = resp[1];
  }

  return completeRespObj(result, contentType);
};

function buildProvidesCtx() {
  var providesFuncs = {};
  var types = [];

  function registerType(key) {
    //signature: key, *mimes
    var mimes = Array.prototype.slice.call(arguments, 1);
    types.push([key, mimes]);
  }
  registerType("all", "*/*");
  registerType("text", "text/plain; charset=utf-8", "txt");
  registerType("html", "text/html; charset=utf-8");
  registerType("xhtml", "application/xhtml+xml", "xhtml");
  registerType("xml", "application/xml", "text/xml", "application/x-xml");
  registerType("js", "text/javascript", "application/javascript", "application/x-javascript");
  registerType("css", "text/css");
  registerType("ics", "text/calendar");
  registerType("csv", "text/csv");
  registerType("rss", "application/rss+xml");
  registerType("atom", "application/atom+xml");
  registerType("yaml", "application/x-yaml", "text/yaml");
  registerType("multipart_form", "multipart/form-data");
  registerType("url_encoded_form", "application/x-www-form-urlencoded");
  registerType("json", "application/json", "text/x-json");

  function execute(type) {
    try {
      return providesFuncs[type]();
    } catch (e) {
      throw coucheval.wrapExecutionError(e);
    }
  }

  function getRelevantTypes() {
    return types.filter(function (type) {
      return providesFuncs.hasOwnProperty(type[0]);
    });
  }

  function contentTypeFor(searchedType) {
    for (var i = 0; i < types.length; i += 1) {
      if (types[i][0] === searchedType) {
        return types[i][1][0];
      }
    }
  }

  function bestMatchForAcceptHeader(header) {
    var requestedMimes = parseAcceptHeader(header);
    var relevantTypes = getRelevantTypes();
    for (var i = 0; i < requestedMimes.length; i += 1) {
      var requestedMime = requestedMimes[i];
      var requestedParts = requestedMime.split(";")[0].trim().split("/");

      for (var j = 0; j < relevantTypes.length; j += 1) {
        var type = relevantTypes[j][0];
        var mimes = relevantTypes[j][1];

        for (var k = 0; k < mimes.length; k += 1) {
          var mime = mimes[k];

          var availableParts = mime.split(";")[0].trim().split("/");
          var match = (
            (
              //'text' in text/plain
              requestedParts[0] === availableParts[0] ||
              requestedParts[0] === "*" || availableParts[0] === "*"
            ) && (
              //'plain' in text/plain
              requestedParts[1] === availableParts[1] ||
              requestedParts[1] === "*" || availableParts[1] === "*"
            )
          );
          if (match) {
            return [type, mime];
          }
        }
      }
    }
    //no match was found
    throw new PouchPluginError({
      status: 406,
      name: "not_acceptable",
      message: [
        "Content-Type(s)",
        requestedMimes.join(", "),
        "not supported, try one of:",
        Object.keys(providesFuncs).map(contentTypeFor)
      ].join(" ")
    });
  }

  function provides(type, func) {
    providesFuncs[type] = func;
  }

  function getResult(req) {
    if (isEmpty(providesFuncs)) {
      return [""];
    }
    if (req.query.format) {
      if (!providesFuncs.hasOwnProperty(req.query.format)) {
        throw new PouchPluginError({
          status: 500,
          name: "render_error",
          message: [
            "the format option is set to '",
            req.query.format,
            //the + thing for es3ify
            "'" + ", but there's no provider registered for that format."
          ].join("")
        });
      }
      //everything fine
      return [execute(req.query.format), contentTypeFor(req.query.format)];
    }
    var chosenType = bestMatchForAcceptHeader(req.headers.Accept);
    return [execute(chosenType[0]), chosenType[1]];
  }

  return {
    api: {
      provides: provides,
      registerType: registerType
    },
    getResult: getResult
  };
}

function parseAcceptHeader(header) {
  return header.split(",").map(function (part) {
    return part.split(";")[0].trim();
  });
}

},{"couchdb-eval":3,"couchdb-resp-completer":4,"extend":6,"is-empty":5,"pouchdb-plugin-error":7}],3:[function(_dereq_,module,exports){
/*
	Copyright 2013-2014, Marten de Vries

	Licensed under the Apache License, Version 2.0 (the "License");
	you may not use this file except in compliance with the License.
	You may obtain a copy of the License at

	http://www.apache.org/licenses/LICENSE-2.0

	Unless required by applicable law or agreed to in writing, software
	distributed under the License is distributed on an "AS IS" BASIS,
	WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
	See the License for the specific language governing permissions and
	limitations under the License.
*/

"use strict";

var PouchPluginError = _dereq_("pouchdb-plugin-error");
var extend = _dereq_("extend");

exports.evaluate = function (requireContext, extraVars, program) {
  /*jshint unused: false */
  var require;
  if (requireContext) {
    require = function (libPath) {
      var requireLocals = extend({
        module: {
          id: libPath,
          //no way to fill in current and parent that I know of
          current: undefined,
          parent: undefined,
          exports: {}
        }
      }, locals);
      requireLocals.exports = requireLocals.module.exports;

      var path = libPath.split("/");
      var lib = requireContext;
      for (var i = 0; i < path.length; i += 1) {
        lib = lib[path[i]];
      }
      lib += "\nreturn module.exports;";
      return evalProgram(lib, requireLocals);
    };
  }

  //Strip trailing ';'s to make it more likely to be a valid expression
  program = program.replace(/;\s*$/, "");

  var locals = extend({
    isArray: isArray,
    toJSON: toJSON,
    log: log,
    sum: sum,
    require: require
  }, extraVars);
  var func;
  try {
    func = evalProgram("return " + program, locals);
    if (typeof func !== "function") {
      //activate the exception handling mechanism down here.
      throw "no function";
    }
  } catch (e) {
    throw new PouchPluginError({
      "name": "compilation_error",
      "status": 500,
      "message": "Expression does not eval to a function. " + program
    });
  }
  return func;
};

var isArray = Array.isArray;
var toJSON = JSON.stringify;
var log = function (message) {
  if (typeof message != "string") {
    message = JSON.stringify(message);
  }
  console.log("EVALUATED FUNCTION LOGS: " + message);
};
var sum = function (array) {
  return array.reduce(function (a, b) {
    return a + b;
  });
};

function evalProgram(program, locals) {
  /*jshint evil:true */
  var keys = Object.keys(locals);
  var values = keys.map(function (key) {
    return locals[key];
  });
  var code = (
    "(function (" + keys.join(", ") + ") {" +
      program +
    "})"
  );

  return eval(code).apply(null, values);
}

exports.wrapExecutionError = function (e) {
  return new PouchPluginError({
    name: e.name,
    message: e.toString() + "\n\n" + e.stack,
    status: 500
  });
};

},{"extend":6,"pouchdb-plugin-error":7}],4:[function(_dereq_,module,exports){
/*
  Copyright 2013-2014, Marten de Vries

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

  http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

"use strict";

var extend = _dereq_("extend");
var isEmpty = _dereq_("is-empty");
var PouchPluginError = _dereq_("pouchdb-plugin-error");

module.exports = function completeRespObj(resp, contentType) {
  //contentType may be undefined (if unknown). Resp may be anything
  //returned by the user as response.

  if (typeof resp === "string") {
    resp = {body: resp};
  }
  if (Object.prototype.toString.call(resp) !== "[object Object]") {
    resp = {};
  }
  //check for keys that shouldn't be in the resp object
  var copy = extend({}, resp);
  delete copy.code;
  delete copy.json;
  delete copy.body;
  delete copy.base64;
  delete copy.headers;
  delete copy.stop;
  if (!isEmpty(copy)) {
    var key = Object.keys(copy)[0];
    throw new PouchPluginError({
      "status": 500,
      "name": "external_response_error",
      "message": [
        "Invalid data from external server: {<<",
        JSON.stringify(key),
        ">>,<<",
        JSON.stringify(copy[key]),
        ">>}"
      ].join("")
    });
  }
  resp.code = resp.code || 200;
  resp.headers = resp.headers || {};
  resp.headers.Vary = resp.headers.Vary || "Accept";
  //if a content type is known by now, use it.
  resp.headers["Content-Type"] = resp.headers["Content-Type"] || contentType;
  if (typeof resp.json !== 'undefined') {
    resp.body = JSON.stringify(resp.json);
    resp.headers["Content-Type"] = resp.headers["Content-Type"] || "application/json";
  }
  if (typeof resp.base64 !== 'undefined') {
    resp.headers["Content-Type"] = resp.headers["Content-Type"] || "application/binary";
  }
  //the default content type
  resp.headers["Content-Type"] = resp.headers["Content-Type"] || "text/html; charset=utf-8";

  //the user isn't allowed to set the etag header
  delete resp.headers.Etag;

  if (typeof resp.body === "undefined" && typeof resp.base64 === "undefined") {
    resp.body = "";
  }

  return resp;
};

},{"extend":6,"is-empty":5,"pouchdb-plugin-error":7}],5:[function(_dereq_,module,exports){

/**
 * Expose `isEmpty`.
 */

module.exports = isEmpty;


/**
 * Has.
 */

var has = Object.prototype.hasOwnProperty;


/**
 * Test whether a value is "empty".
 *
 * @param {Mixed} val
 * @return {Boolean}
 */

function isEmpty (val) {
  if (null == val) return true;
  if ('number' == typeof val) return 0 === val;
  if (undefined !== val.length) return 0 === val.length;
  for (var key in val) if (has.call(val, key)) return false;
  return true;
}
},{}],6:[function(_dereq_,module,exports){
var hasOwn = Object.prototype.hasOwnProperty;
var toString = Object.prototype.toString;
var undefined;

var isPlainObject = function isPlainObject(obj) {
	"use strict";
	if (!obj || toString.call(obj) !== '[object Object]' || obj.nodeType || obj.setInterval) {
		return false;
	}

	var has_own_constructor = hasOwn.call(obj, 'constructor');
	var has_is_property_of_method = obj.constructor && obj.constructor.prototype && hasOwn.call(obj.constructor.prototype, 'isPrototypeOf');
	// Not own constructor property must be Object
	if (obj.constructor && !has_own_constructor && !has_is_property_of_method) {
		return false;
	}

	// Own properties are enumerated firstly, so to speed up,
	// if last one is own, then all properties are own.
	var key;
	for (key in obj) {}

	return key === undefined || hasOwn.call(obj, key);
};

module.exports = function extend() {
	"use strict";
	var options, name, src, copy, copyIsArray, clone,
		target = arguments[0],
		i = 1,
		length = arguments.length,
		deep = false;

	// Handle a deep copy situation
	if (typeof target === "boolean") {
		deep = target;
		target = arguments[1] || {};
		// skip the boolean and the target
		i = 2;
	} else if (typeof target !== "object" && typeof target !== "function" || target == undefined) {
			target = {};
	}

	for (; i < length; ++i) {
		// Only deal with non-null/undefined values
		if ((options = arguments[i]) != null) {
			// Extend the base object
			for (name in options) {
				src = target[name];
				copy = options[name];

				// Prevent never-ending loop
				if (target === copy) {
					continue;
				}

				// Recurse if we're merging plain objects or arrays
				if (deep && copy && (isPlainObject(copy) || (copyIsArray = Array.isArray(copy)))) {
					if (copyIsArray) {
						copyIsArray = false;
						clone = src && Array.isArray(src) ? src : [];
					} else {
						clone = src && isPlainObject(src) ? src : {};
					}

					// Never move original objects, clone them
					target[name] = extend(deep, clone, copy);

				// Don't bring in undefined values
				} else if (copy !== undefined) {
					target[name] = copy;
				}
			}
		}
	}

	// Return the modified object
	return target;
};


},{}],7:[function(_dereq_,module,exports){
/*
  Copyright 2014, Marten de Vries

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

  http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

"use strict";

function PouchPluginError(opts) {
  this.status = opts.status;
  this.name = opts.name;
  this.message = opts.message;
  this.error = true;
  this.stack = (new Error()).stack;
}

PouchPluginError.prototype.toString = function () {
  return JSON.stringify({
    status: this.status,
    name: this.name,
    message: this.message
  });
};

module.exports = PouchPluginError;

},{}]},{},[1])
(1)
});