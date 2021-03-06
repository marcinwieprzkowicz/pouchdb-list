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

var extend = require("extend");
var coucheval = require("couchdb-eval");
var PouchPluginError = require("pouchdb-plugin-error");

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
