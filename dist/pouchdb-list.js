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
var coucheval = _dereq_("couchdb-eval");
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
    var respInfo;
    var chunks = [];
    var result;
    var rows = viewResp.rows;

    var listApi = {
      getRow: function () {
        return rows.shift() || null;
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

    var func = coucheval.evaluate(designDoc, listApi, designDoc.lists[listName]);
    try {
      result = func.call(designDoc);
    } catch (e) {
      throw coucheval.wrapExecutionError(e);
    }

    return JSON.parse(result);
  }, null));
}

},{"couchdb-eval":2,"extend":3,"pouchdb-plugin-error":4}],2:[function(_dereq_,module,exports){
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

},{"extend":3,"pouchdb-plugin-error":4}],3:[function(_dereq_,module,exports){
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


},{}],4:[function(_dereq_,module,exports){
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