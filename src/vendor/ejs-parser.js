'use strict';
// Frozen EJS browser library from ST-Prompt-Template d6f520d149aba146305b0b781ddd691d449c28d2.
// Engine SHA-256: 66b3c84f33adbf154950e18cb55704062e3fa5e2f4e69001f6df296d11548d54
function createEjsParserLibrary() {
/*

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

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
var module = { exports: {} }, exports = module.exports;
(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.ejs = f()}})(function(){var define,module,exports;return (function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
    /*
     * EJS Embedded JavaScript templates
     * Copyright 2112 Matthew Eernisse (mde@fleegix.org)
     *
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     *         http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     *
    */
    
    'use strict';
    
    /**
     * @file Embedded JavaScript templating engine. {@link http://ejs.co}
     * @author Matthew Eernisse <mde@fleegix.org>
     * @author Tiancheng "Timothy" Gu <timothygu99@gmail.com>
     * @project EJS
     * @license {@link http://www.apache.org/licenses/LICENSE-2.0 Apache License, Version 2.0}
     */
    
    /**
     * EJS internal functions.
     *
     * Technically this "module" lies in the same file as {@link module:ejs}, for
     * the sake of organization all the private functions re grouped into this
     * module.
     *
     * @module ejs-internal
     * @private
     */
    
    /**
     * Embedded JavaScript templating engine.
     *
     * @module ejs
     * @public
     */
    
    
    var fs = require('fs');
    var path = require('path');
    var utils = require('./utils');
    
    var scopeOptionWarned = false;
    /** @type {string} */
    var _VERSION_STRING = require('../package.json').version;
    var _DEFAULT_OPEN_DELIMITER = '<';
    var _DEFAULT_CLOSE_DELIMITER = '>';
    var _DEFAULT_DELIMITER = '%';
    var _DEFAULT_LOCALS_NAME = 'locals';
    var _NAME = 'ejs';
    var _REGEX_STRING = '(<%%|%%>|<%=|<%-|<%_|<%#|<%|%>|-%>|_%>)';
    var _OPTS_PASSABLE_WITH_DATA = ['delimiter', 'scope', 'context', 'debug', 'compileDebug',
        'client', '_with', 'rmWhitespace', 'strict', 'filename', 'async'];
    // We don't allow 'cache' option to be passed in the data obj for
    // the normal `render` call, but this is where Express 2 & 3 put it
    // so we make an exception for `renderFile`
    var _OPTS_PASSABLE_WITH_DATA_EXPRESS = _OPTS_PASSABLE_WITH_DATA.concat('cache');
    var _BOM = /^\uFEFF/;
    var _JS_IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$_]*$/u;
    
    /**
     * EJS template function cache. This can be a LRU object from lru-cache NPM
     * module. By default, it is {@link module:utils.cache}, a simple in-process
     * cache that grows continuously.
     *
     * @type {Cache}
     */
    
    exports.cache = utils.cache;
    
    /**
     * Custom file loader. Useful for template preprocessing or restricting access
     * to a certain part of the filesystem.
     *
     * @type {fileLoader}
     */
    
    exports.fileLoader = fs.readFileSync;
    
    /**
     * Name of the object containing the locals.
     *
     * This variable is overridden by {@link Options}`.localsName` if it is not
     * `undefined`.
     *
     * @type {String}
     * @public
     */
    
    exports.localsName = _DEFAULT_LOCALS_NAME;
    
    /**
     * Promise implementation -- defaults to the native implementation if available
     * This is mostly just for testability
     *
     * @type {PromiseConstructorLike}
     * @public
     */
    
    exports.promiseImpl = (new Function('return this;'))().Promise;
    
    /**
     * Get the path to the included file from the parent file path and the
     * specified path.
     *
     * @param {String}  name     specified path
     * @param {String}  filename parent file path
     * @param {Boolean} [isDir=false] whether the parent file path is a directory
     * @return {String}
     */
    exports.resolveInclude = function(name, filename, isDir) {
        var dirname = path.dirname;
        var extname = path.extname;
        var resolve = path.resolve;
        var includePath = resolve(isDir ? filename : dirname(filename), name);
        var ext = extname(name);
        if (!ext) {
            includePath += '.ejs';
        }
        return includePath;
    };
    
    /**
     * Try to resolve file path on multiple directories
     *
     * @param  {String}        name  specified path
     * @param  {Array<String>} paths list of possible parent directory paths
     * @return {String}
     */
    function resolvePaths(name, paths) {
        var filePath;
        if (paths.some(function (v) {
            filePath = exports.resolveInclude(name, v, true);
            return fs.existsSync(filePath);
        })) {
            return filePath;
        }
    }
    
    /**
     * Get the path to the included file by Options
     *
     * @param  {String}  path    specified path
     * @param  {Options} options compilation options
     * @return {String}
     */
    function getIncludePath(path, options) {
        var includePath;
        var filePath;
        var views = options.views;
        var match = /^[A-Za-z]+:\\|^\//.exec(path);
    
        // Abs path
        if (match && match.length) {
            path = path.replace(/^\/*/, '');
            if (Array.isArray(options.root)) {
                includePath = resolvePaths(path, options.root);
            } else {
                includePath = exports.resolveInclude(path, options.root || '/', true);
            }
        }
        // Relative paths
        else {
            // Look relative to a passed filename first
            if (options.filename) {
                filePath = exports.resolveInclude(path, options.filename);
                if (fs.existsSync(filePath)) {
                    includePath = filePath;
                }
            }
            // Then look in any views directories
            if (!includePath && Array.isArray(views)) {
                includePath = resolvePaths(path, views);
            }
            if (!includePath && typeof options.includer !== 'function') {
                throw new Error('Could not find the include file "' +
                        options.escapeFunction(path) + '"');
            }
        }
        return includePath;
    }
    
    /**
     * Get the template from a string or a file, either compiled on-the-fly or
     * read from cache (if enabled), and cache the template if needed.
     *
     * If `template` is not set, the file specified in `options.filename` will be
     * read.
     *
     * If `options.cache` is true, this function reads the file from
     * `options.filename` so it must be set prior to calling this function.
     *
     * @memberof module:ejs-internal
     * @param {Options} options   compilation options
     * @param {String} [template] template source
     * @return {(TemplateFunction|ClientFunction)}
     * Depending on the value of `options.client`, either type might be returned.
     * @static
     */
    
    function handleCache(options, template) {
        var func;
        var filename = options.filename;
        var hasTemplate = arguments.length > 1;
    
        if (options.cache) {
            if (!filename) {
                throw new Error('cache option requires a filename');
            }
            func = exports.cache.get(filename);
            if (func) {
                return func;
            }
            if (!hasTemplate) {
                template = fileLoader(filename).toString().replace(_BOM, '');
            }
        }
        else if (!hasTemplate) {
            // istanbul ignore if: should not happen at all
            if (!filename) {
                throw new Error('Internal EJS error: no file name or template '
                                            + 'provided');
            }
            template = fileLoader(filename).toString().replace(_BOM, '');
        }
        func = exports.compile(template, options);
        if (options.cache) {
            exports.cache.set(filename, func);
        }
        return func;
    }
    
    /**
     * Try calling handleCache with the given options and data and call the
     * callback with the result. If an error occurs, call the callback with
     * the error. Used by renderFile().
     *
     * @memberof module:ejs-internal
     * @param {Options} options    compilation options
     * @param {Object} data        template data
     * @param {RenderFileCallback} cb callback
     * @static
     */
    
    function tryHandleCache(options, data, cb) {
        var result;
        if (!cb) {
            if (typeof exports.promiseImpl == 'function') {
                return new exports.promiseImpl(function (resolve, reject) {
                    try {
                        result = handleCache(options)(data);
                        resolve(result);
                    }
                    catch (err) {
                        reject(err);
                    }
                });
            }
            else {
                throw new Error('Please provide a callback function');
            }
        }
        else {
            try {
                result = handleCache(options)(data);
            }
            catch (err) {
                return cb(err);
            }
    
            cb(null, result);
        }
    }
    
    /**
     * fileLoader is independent
     *
     * @param {String} filePath ejs file path.
     * @return {String} The contents of the specified file.
     * @static
     */
    
    function fileLoader(filePath){
        return exports.fileLoader(filePath);
    }
    
    /**
     * Get the template function.
     *
     * If `options.cache` is `true`, then the template is cached.
     *
     * @memberof module:ejs-internal
     * @param {String}  path    path for the specified file
     * @param {Options} options compilation options
     * @return {(TemplateFunction|ClientFunction)}
     * Depending on the value of `options.client`, either type might be returned
     * @static
     */
    
    function includeFile(path, options) {
        var opts = utils.shallowCopy(utils.createNullProtoObjWherePossible(), options);
        opts.filename = getIncludePath(path, opts);
        if (typeof options.includer === 'function') {
            var includerResult = options.includer(path, opts.filename);
            if (includerResult) {
                if (includerResult.filename) {
                    opts.filename = includerResult.filename;
                }
                if (includerResult.template) {
                    return handleCache(opts, includerResult.template);
                }
            }
        }
        return handleCache(opts);
    }
    
    /**
     * Re-throw the given `err` in context to the `str` of ejs, `filename`, and
     * `lineno`.
     *
     * @implements {RethrowCallback}
     * @memberof module:ejs-internal
     * @param {Error}  err      Error object
     * @param {String} str      EJS source
     * @param {String} flnm     file name of the EJS file
     * @param {Number} lineno   line number of the error
     * @param {EscapeCallback} esc
     * @static
     */
    
    function rethrow(err, str, flnm, lineno, esc) {
        var lines = str.split('\n');
        var start = Math.max(lineno - 3, 0);
        var end = Math.min(lines.length, lineno + 3);
        var filename = esc(flnm);
        // Error context
        var context = lines.slice(start, end).map(function (line, i){
            var curr = i + start + 1;
            return (curr == lineno ? ' >> ' : '    ')
                + curr
                + '| '
                + line;
        }).join('\n');
    
        // Alter exception message
        err.path = filename;
        err.message = (filename || 'ejs') + ':'
            + lineno + '\n'
            + context + '\n\n'
            + err.message;
    
        throw err;
    }
    
    function stripSemi(str){
        return str.replace(/;(\s*$)/, '$1');
    }
    
    /**
     * Compile the given `str` of ejs into a template function.
     *
     * @param {String}  template EJS template
     *
     * @param {Options} [opts] compilation options
     *
     * @return {(TemplateFunction|ClientFunction)}
     * Depending on the value of `opts.client`, either type might be returned.
     * Note that the return type of the function also depends on the value of `opts.async`.
     * @public
     */
    
    exports.compile = function compile(template, opts) {
        var templ;
    
        // v1 compat
        // 'scope' is 'context'
        // FIXME: Remove this in a future version
        if (opts && opts.scope) {
            if (!scopeOptionWarned){
                console.warn('`scope` option is deprecated and will be removed in EJS 3');
                scopeOptionWarned = true;
            }
            if (!opts.context) {
                opts.context = opts.scope;
            }
            delete opts.scope;
        }
        templ = new Template(template, opts);
        return templ.compile();
    };
    
    /**
     * Render the given `template` of ejs.
     *
     * If you would like to include options but not data, you need to explicitly
     * call this function with `data` being an empty object or `null`.
     *
     * @param {String}   template EJS template
     * @param {Object}  [data={}] template data
     * @param {Options} [opts={}] compilation and rendering options
     * @return {(String|Promise<String>)}
     * Return value type depends on `opts.async`.
     * @public
     */
    
    exports.render = function (template, d, o) {
        var data = d || utils.createNullProtoObjWherePossible();
        var opts = o || utils.createNullProtoObjWherePossible();
    
        // No options object -- if there are optiony names
        // in the data, copy them to options
        if (arguments.length == 2) {
            utils.shallowCopyFromList(opts, data, _OPTS_PASSABLE_WITH_DATA);
        }
    
        return handleCache(opts, template)(data);
    };
    
    /**
     * Render an EJS file at the given `path` and callback `cb(err, str)`.
     *
     * If you would like to include options but not data, you need to explicitly
     * call this function with `data` being an empty object or `null`.
     *
     * @param {String}             path     path to the EJS file
     * @param {Object}            [data={}] template data
     * @param {Options}           [opts={}] compilation and rendering options
     * @param {RenderFileCallback} cb callback
     * @public
     */
    
    exports.renderFile = function () {
        var args = Array.prototype.slice.call(arguments);
        var filename = args.shift();
        var cb;
        var opts = {filename: filename};
        var data;
        var viewOpts;
    
        // Do we have a callback?
        if (typeof arguments[arguments.length - 1] == 'function') {
            cb = args.pop();
        }
        // Do we have data/opts?
        if (args.length) {
            // Should always have data obj
            data = args.shift();
            // Normal passed opts (data obj + opts obj)
            if (args.length) {
                // Use shallowCopy so we don't pollute passed in opts obj with new vals
                utils.shallowCopy(opts, args.pop());
            }
            // Special casing for Express (settings + opts-in-data)
            else {
                // Express 3 and 4
                if (data.settings) {
                    // Pull a few things from known locations
                    if (data.settings.views) {
                        opts.views = data.settings.views;
                    }
                    if (data.settings['view cache']) {
                        opts.cache = true;
                    }
                    // Undocumented after Express 2, but still usable, esp. for
                    // items that are unsafe to be passed along with data, like `root`
                    viewOpts = data.settings['view options'];
                    if (viewOpts) {
                        utils.shallowCopy(opts, viewOpts);
                    }
                }
                // Express 2 and lower, values set in app.locals, or people who just
                // want to pass options in their data. NOTE: These values will override
                // anything previously set in settings  or settings['view options']
                utils.shallowCopyFromList(opts, data, _OPTS_PASSABLE_WITH_DATA_EXPRESS);
            }
            opts.filename = filename;
        }
        else {
            data = utils.createNullProtoObjWherePossible();
        }
    
        return tryHandleCache(opts, data, cb);
    };
    
    /**
     * Clear intermediate JavaScript cache. Calls {@link Cache#reset}.
     * @public
     */
    
    /**
     * EJS template class
     * @public
     */
    exports.Template = Template;
    
    exports.clearCache = function () {
        exports.cache.reset();
    };
    
    function Template(text, optsParam) {
        var opts = utils.hasOwnOnlyObject(optsParam);
        var options = utils.createNullProtoObjWherePossible();
        this.templateText = text;
        /** @type {string | null} */
        this.mode = null;
        this.truncate = false;
        this.currentLine = 1;
        this.source = '';
        options.client = opts.client || false;
        options.escapeFunction = opts.escape || opts.escapeFunction || utils.escapeXML;
        options.compileDebug = opts.compileDebug !== false;
        options.debug = !!opts.debug;
        options.filename = opts.filename;
        options.openDelimiter = opts.openDelimiter || exports.openDelimiter || _DEFAULT_OPEN_DELIMITER;
        options.closeDelimiter = opts.closeDelimiter || exports.closeDelimiter || _DEFAULT_CLOSE_DELIMITER;
        options.delimiter = opts.delimiter || exports.delimiter || _DEFAULT_DELIMITER;
        options.strict = opts.strict || false;
        options.context = opts.context;
        options.cache = opts.cache || false;
        options.rmWhitespace = opts.rmWhitespace;
        options.root = opts.root;
        options.includer = opts.includer;
        options.outputFunctionName = opts.outputFunctionName;
        options.localsName = opts.localsName || exports.localsName || _DEFAULT_LOCALS_NAME;
        options.views = opts.views;
        options.async = opts.async;
        options.destructuredLocals = opts.destructuredLocals;
        options.legacyInclude = typeof opts.legacyInclude != 'undefined' ? !!opts.legacyInclude : true;
    
        if (options.strict) {
            options._with = false;
        }
        else {
            options._with = typeof opts._with != 'undefined' ? opts._with : true;
        }
    
        this.opts = options;
    
        this.regex = this.createRegex();
    }
    
    Template.modes = {
        EVAL: 'eval',
        ESCAPED: 'escaped',
        RAW: 'raw',
        COMMENT: 'comment',
        LITERAL: 'literal'
    };
    
    Template.prototype = {
        createRegex: function () {
            var str = _REGEX_STRING;
            var delim = utils.escapeRegExpChars(this.opts.delimiter);
            var open = utils.escapeRegExpChars(this.opts.openDelimiter);
            var close = utils.escapeRegExpChars(this.opts.closeDelimiter);
            str = str.replace(/%/g, delim)
                .replace(/</g, open)
                .replace(/>/g, close);
            return new RegExp(str);
        },
    
        compile: function () {
            /** @type {string} */
            var src;
            /** @type {ClientFunction} */
            var fn;
            var opts = this.opts;
            var prepended = '';
            var appended = '';
            /** @type {EscapeCallback} */
            var escapeFn = opts.escapeFunction;
            /** @type {FunctionConstructor} */
            var ctor;
            /** @type {string} */
            var sanitizedFilename = opts.filename ? JSON.stringify(opts.filename) : 'undefined';
    
            if (!this.source) {
                this.generateSource();
                prepended +=
                    '  var __output = "";\n' +
                    '  function __append(...args) { args.filter(x => x !== undefined && x !== null).forEach(s => __output += s) }\n';
                if (opts.outputFunctionName) {
                    if (!_JS_IDENTIFIER.test(opts.outputFunctionName)) {
                        throw new Error('outputFunctionName is not a valid JS identifier.');
                    }
                    prepended += '  const ' + opts.outputFunctionName + ' = __append;' + '\n';
                }
                if (opts.localsName && !_JS_IDENTIFIER.test(opts.localsName)) {
                    throw new Error('localsName is not a valid JS identifier.');
                }
                if (opts.destructuredLocals && opts.destructuredLocals.length) {
                    var destructuring = ' {\n  const __locals = (' + opts.localsName + ' || {}),\n  ';
                    for (var i = 0; i < opts.destructuredLocals.length; i++) {
                        var name = opts.destructuredLocals[i];
                        if (!_JS_IDENTIFIER.test(name)) {
                            throw new Error('destructuredLocals[' + i + '] is not a valid JS identifier.');
                        }
                        if (i > 0) {
                            destructuring += ',\n  ';
                        }
                        destructuring += name + ' = __locals.' + name;
                    }
                    prepended += destructuring + ';\n';
                }
                if (opts._with !== false) {
                    prepended +=  '  with (' + opts.localsName + ' || {}) ';
                }
                prepended +=  ' {' + '\n';
                appended += '  }' + '\n';
                if (opts.destructuredLocals && opts.destructuredLocals.length)
                    appended += '  }\n';
                
                appended += '  return __output;' + '\n';
                this.source = prepended + this.source + appended;
            }
    
            if (opts.compileDebug) {
                src = 'var __line = 1' + '\n'
                    + '  , __lines = ' + JSON.stringify(this.templateText) + '\n'
                    + '  , __filename = ' + sanitizedFilename + ';' + '\n'
                    + 'try {' + '\n'
                    + this.source
                    + '} catch (e) {' + '\n'
                    + '  rethrow(e, __lines, __filename, __line, escapeFn);' + '\n'
                    + '}' + '\n';
            }
            else {
                src = this.source;
            }
    
            if (opts.client) {
                src = 'escapeFn = escapeFn || ' + escapeFn.toString() + ';' + '\n' + src;
                if (opts.compileDebug) {
                    src = 'rethrow = rethrow || ' + rethrow.toString() + ';' + '\n' + src;
                }
            }
    
            if (opts.strict) {
                src = '"use strict";\n' + src;
            }
            if (opts.debug) {
                console.log(src);
            }
            if (opts.compileDebug && opts.filename) {
                src = src + '\n'
                    + '//# sourceURL=' + sanitizedFilename + '\n';
            }
    
            try {
                if (opts.async) {
                    // Have to use generated function for this, since in envs without support,
                    // it breaks in parsing
                    try {
                        ctor = (new Function('return (async function(){}).constructor;'))();
                    }
                    catch(e) {
                        if (e instanceof SyntaxError) {
                            throw new Error('This environment does not support async/await');
                        }
                        else {
                            throw e;
                        }
                    }
                }
                else {
                    ctor = Function;
                }
                fn = new ctor(opts.localsName + ', escapeFn, include, rethrow', src);
            }
            catch(e) {
                e.src = src;
                // istanbul ignore else
                if (e instanceof SyntaxError) {
                    if (opts.filename) {
                        e.message += ' in ' + opts.filename;
                    }
                    e.message += ' while compiling ejs\n\n';
                    /*
                    e.message += 'If the above error is not helpful, you may want to try EJS-Lint:\n';
                    e.message += 'https://github.com/RyanZim/EJS-Lint';
                    if (!opts.async) {
                        e.message += '\n';
                        e.message += 'Or, if you meant to create an async function, pass `async: true` as an option.';
                    }
                    */
                }
                throw e;
            }
    
            // Return a callable function which will execute the function
            // created by the source-code, with the passed data as locals
            // Adds a local `include` function which allows full recursive include
            var returnedFn = opts.client ? fn : function anonymous(data) {
                var include = function (path, includeData) {
                    var d = utils.shallowCopy(utils.createNullProtoObjWherePossible(), data);
                    if (includeData) {
                        d = utils.shallowCopy(d, includeData);
                    }
                    return includeFile(path, opts)(d);
                };
                return fn.apply(opts.context,
                    [data || utils.createNullProtoObjWherePossible(), escapeFn, include, rethrow]);
            };
            if (opts.filename && typeof Object.defineProperty === 'function') {
                var filename = opts.filename;
                var basename = path.basename(filename, path.extname(filename));
                try {
                    Object.defineProperty(returnedFn, 'name', {
                        value: basename,
                        writable: false,
                        enumerable: false,
                        configurable: true
                    });
                } catch (e) {/* ignore */}
            }
            return returnedFn;
        },
    
        generateSource: function() {
            var opts = this.opts;
            var d = this.opts.delimiter;
            var o = this.opts.openDelimiter;
            var c = this.opts.closeDelimiter;
        
            if (opts.rmWhitespace) {
                this.templateText =
                    this.templateText.replace(/[\r\n]+/g, '\n').replace(/^\s+|\s+$/gm, '');
            }
            this.templateText =
                this.templateText.replace(/[ \t]*<%_/gm, '<%_').replace(/_%>[ \t]*/gm, '_%>');
            
        
            var allTokens = this.parseTemplateText();
            var processedTokens = [];
            var i = 0;
        
            while (i < allTokens.length) {
                var token = allTokens[i];
        
                if (token.startsWith(o + d) && token !== o + d + d) {
                    var nestingLevel = 1;
                    var contentBuffer = [];
                    var j = i + 1;
        
                    while (j < allTokens.length) {
                        var innerToken = allTokens[j];
        
                        if (innerToken.startsWith(o + d) && innerToken !== o + d + d) {
                            nestingLevel++;
                        } else if (innerToken.endsWith(d + c) && innerToken !== d + d + c) {
                            nestingLevel--;
        
                            if (nestingLevel === 0) {
                                processedTokens.push(token);
                                processedTokens.push(contentBuffer.join(''));
                                processedTokens.push(innerToken);
                                
                                i = j; 
                                break; 
                            }
                        }
                        
                        contentBuffer.push(innerToken);
                        j++;
                    }
                    
                    if (nestingLevel !== 0) {
                         throw new Error('Could not find matching close tag for "' + token + '".');
                    }
        
                } else {
                    processedTokens.push(token);
                }
        
                i++;
            }
        
            var self = this;
            if (processedTokens.length) {
                processedTokens.forEach(function (line) {
                    self.scanLine(line);
                });
            }
        },
        
        parseTemplateText: function () {
            var str = this.templateText;
            var pat = this.regex;
            var result = pat.exec(str);
            var arr = [];
            var firstPos;
    
            while (result) {
                firstPos = result.index;
    
                if (firstPos !== 0) {
                    arr.push(str.substring(0, firstPos));
                    str = str.slice(firstPos);
                }
    
                arr.push(result[0]);
                str = str.slice(result[0].length);
                result = pat.exec(str);
            }
    
            if (str) {
                arr.push(str);
            }
    
            return arr;
        },
    
        _addOutput: function (line) {
            if (this.truncate) {
                // Only replace single leading linebreak in the line after
                // -%> tag -- this is the single, trailing linebreak
                // after the tag that the truncation mode replaces
                // Handle Win / Unix / old Mac linebreaks -- do the \r\n
                // combo first in the regex-or
                line = line.replace(/^(?:\r\n|\r|\n)/, '');
                this.truncate = false;
            }
            if (!line) {
                return line;
            }
    
            // Preserve literal slashes
            line = line.replace(/\\/g, '\\\\');
    
            // Convert linebreaks
            line = line.replace(/\n/g, '\\n');
            line = line.replace(/\r/g, '\\r');
    
            // Escape double-quotes
            // - this will be the delimiter during execution
            line = line.replace(/"/g, '\\"');
            this.source += '    ; __append("' + line + '")' + '\n';
        },
    
        scanLine: function (line) {
            var self = this;
            var d = this.opts.delimiter;
            var o = this.opts.openDelimiter;
            var c = this.opts.closeDelimiter;
            var newLineCount = 0;
    
            newLineCount = (line.split('\n').length - 1);
    
            switch (line) {
            case o + d:
            case o + d + '_':
                this.mode = Template.modes.EVAL;
                break;
            case o + d + '=':
                this.mode = Template.modes.ESCAPED;
                break;
            case o + d + '-':
                this.mode = Template.modes.RAW;
                break;
            case o + d + '#':
                this.mode = Template.modes.COMMENT;
                break;
            case o + d + d:
                this.mode = Template.modes.LITERAL;
                this.source += '    ; __append("' + line.replace(o + d + d, o + d) + '")' + '\n';
                break;
            case d + d + c:
                this.mode = Template.modes.LITERAL;
                this.source += '    ; __append("' + line.replace(d + d + c, d + c) + '")' + '\n';
                break;
            case d + c:
            case '-' + d + c:
            case '_' + d + c:
                if (this.mode == Template.modes.LITERAL) {
                    this._addOutput(line);
                }
    
                this.mode = null;
                this.truncate = line.indexOf('-') === 0 || line.indexOf('_') === 0;
                break;
            default:
                // In script mode, depends on type of tag
                if (this.mode) {
                    // If '//' is found without a line break, add a line break.
                    switch (this.mode) {
                    case Template.modes.EVAL:
                    case Template.modes.ESCAPED:
                    case Template.modes.RAW:
                        if (line.lastIndexOf('//') > line.lastIndexOf('\n')) {
                            line += '\n';
                        }
                    }
                    switch (this.mode) {
                    // Just executing code
                    case Template.modes.EVAL:
                        this.source += '    ; ' + line + '\n';
                        break;
                        // Exec, esc, and output
                    case Template.modes.ESCAPED:
                        this.source += '    ; __append(escapeFn(' + stripSemi(line) + '))' + '\n';
                        break;
                        // Exec and output
                    case Template.modes.RAW:
                        this.source += '    ; __append(' + stripSemi(line) + ')' + '\n';
                        break;
                    case Template.modes.COMMENT:
                        // Do nothing
                        break;
                        // Literal <%% mode, append as raw output
                    case Template.modes.LITERAL:
                        this._addOutput(line);
                        break;
                    }
                }
                // In string mode, just add the output
                else {
                    this._addOutput(line);
                }
            }
    
            if (self.opts.compileDebug && newLineCount) {
                this.currentLine += newLineCount;
                this.source += '    ; __line = ' + this.currentLine + '\n';
            }
        }
    };
    
    /**
     * Escape characters reserved in XML.
     *
     * This is simply an export of {@link module:utils.escapeXML}.
     *
     * If `markup` is `undefined` or `null`, the empty string is returned.
     *
     * @param {String} markup Input string
     * @return {String} Escaped string
     * @public
     * @func
     * */
    exports.escapeXML = utils.escapeXML;
    
    /**
     * Express.js support.
     *
     * This is an alias for {@link module:ejs.renderFile}, in order to support
     * Express.js out-of-the-box.
     *
     * @func
     */
    
    exports.__express = exports.renderFile;
    
    /**
     * Version of EJS.
     *
     * @readonly
     * @type {String}
     * @public
     */
    
    exports.VERSION = _VERSION_STRING;
    
    /**
     * Name for detection of EJS.
     *
     * @readonly
     * @type {String}
     * @public
     */
    
    exports.name = _NAME;
    
    /* istanbul ignore if */
    if (typeof window != 'undefined') {
        window.ejs = exports;
    }
    
    
    },{"../package.json":6,"./utils":2,"fs":3,"path":4}],2:[function(require,module,exports){
    /*
     * EJS Embedded JavaScript templates
     * Copyright 2112 Matthew Eernisse (mde@fleegix.org)
     *
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     *         http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     *
    */
    
    /**
     * Private utility functions
     * @module utils
     * @private
     */
    
    'use strict';
    
    var regExpChars = /[|\\{}()[\]^$+*?.]/g;
    var hasOwnProperty = Object.prototype.hasOwnProperty;
    var hasOwn = function (obj, key) { return hasOwnProperty.apply(obj, [key]); };
    
    /**
     * Escape characters reserved in regular expressions.
     *
     * If `string` is `undefined` or `null`, the empty string is returned.
     *
     * @param {String} string Input string
     * @return {String} Escaped string
     * @static
     * @private
     */
    exports.escapeRegExpChars = function (string) {
        // istanbul ignore if
        if (!string) {
            return '';
        }
        return String(string).replace(regExpChars, '\\$&');
    };
    
    var _ENCODE_HTML_RULES = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&#34;',
        "'": '&#39;'
    };
    var _MATCH_HTML = /[&<>'"]/g;
    
    function encode_char(c) {
        return _ENCODE_HTML_RULES[c] || c;
    }
    
    /**
     * Stringified version of constants used by {@link module:utils.escapeXML}.
     *
     * It is used in the process of generating {@link ClientFunction}s.
     *
     * @readonly
     * @type {String}
     */
    
    var escapeFuncStr =
        'var _ENCODE_HTML_RULES = {\n'
    + '      "&": "&amp;"\n'
    + '    , "<": "&lt;"\n'
    + '    , ">": "&gt;"\n'
    + '    , \'"\': "&#34;"\n'
    + '    , "\'": "&#39;"\n'
    + '    }\n'
    + '  , _MATCH_HTML = /[&<>\'"]/g;\n'
    + 'function encode_char(c) {\n'
    + '  return _ENCODE_HTML_RULES[c] || c;\n'
    + '};\n';
    
    /**
     * Escape characters reserved in XML.
     *
     * If `markup` is `undefined` or `null`, the empty string is returned.
     *
     * @implements {EscapeCallback}
     * @param {String} markup Input string
     * @return {String} Escaped string
     * @static
     * @private
     */
    
    exports.escapeXML = function (markup) {
        return markup == undefined
            ? ''
            : String(markup)
                .replace(_MATCH_HTML, encode_char);
    };
    
    function escapeXMLToString() {
        return Function.prototype.toString.call(this) + ';\n' + escapeFuncStr;
    }
    
    try {
        if (typeof Object.defineProperty === 'function') {
        // If the Function prototype is frozen, the "toString" property is non-writable. This means that any objects which inherit this property
        // cannot have the property changed using an assignment. If using strict mode, attempting that will cause an error. If not using strict
        // mode, attempting that will be silently ignored.
        // However, we can still explicitly shadow the prototype's "toString" property by defining a new "toString" property on this object.
            Object.defineProperty(exports.escapeXML, 'toString', { value: escapeXMLToString });
        } else {
            // If Object.defineProperty() doesn't exist, attempt to shadow this property using the assignment operator.
            exports.escapeXML.toString = escapeXMLToString;
        }
    } catch (err) {
        console.warn('Unable to set escapeXML.toString (is the Function prototype frozen?)');
    }
    
    /**
     * Naive copy of properties from one object to another.
     * Does not recurse into non-scalar properties
     * Does not check to see if the property has a value before copying
     *
     * @param  {Object} to   Destination object
     * @param  {Object} from Source object
     * @return {Object}      Destination object
     * @static
     * @private
     */
    exports.shallowCopy = function (to, from) {
        from = from || {};
        if ((to !== null) && (to !== undefined)) {
            for (var p in from) {
                if (!hasOwn(from, p)) {
                    continue;
                }
                if (p === '__proto__' || p === 'constructor') {
                    continue;
                }
                to[p] = from[p];
            }
        }
        return to;
    };
    
    /**
     * Naive copy of a list of key names, from one object to another.
     * Only copies property if it is actually defined
     * Does not recurse into non-scalar properties
     *
     * @param  {Object} to   Destination object
     * @param  {Object} from Source object
     * @param  {Array} list List of properties to copy
     * @return {Object}      Destination object
     * @static
     * @private
     */
    exports.shallowCopyFromList = function (to, from, list) {
        list = list || [];
        from = from || {};
        if ((to !== null) && (to !== undefined)) {
            for (var i = 0; i < list.length; i++) {
                var p = list[i];
                if (typeof from[p] != 'undefined') {
                    if (!hasOwn(from, p)) {
                        continue;
                    }
                    if (p === '__proto__' || p === 'constructor') {
                        continue;
                    }
                    to[p] = from[p];
                }
            }
        }
        return to;
    };
    
    /**
     * Simple in-process cache implementation. Does not implement limits of any
     * sort.
     *
     * @implements {Cache}
     * @static
     * @private
     */
    exports.cache = {
        _data: new Map(),
        _capacity: 64,
        set: function (key, val) {
            if (this._data.has(key))
                this._data.delete(key);
            this._data.set(key, val);
            while (this._capacity > 0 && this._data.size > this._capacity) {
                const first = this._data.keys().next().value;
                this._data.delete(first);
            }
        },
        get: function (key) {
            if (!this._data.has(key))
                return undefined;
            const value = this._data.get(key);
            this._data.delete(key);
            this._data.set(key, value);
            return value;
        },
        remove: function (key) {
            this._data.delete(key);
        },
        reset: function () {
            this._data.clear();
        }
    };
    
    /**
     * Transforms hyphen case variable into camel case.
     *
     * @param {String} string Hyphen case string
     * @return {String} Camel case string
     * @static
     * @private
     */
    exports.hyphenToCamel = function (str) {
        return str.replace(/-[a-z]/g, function (match) { return match[1].toUpperCase(); });
    };
    
    /**
     * Returns a null-prototype object in runtimes that support it
     *
     * @return {Object} Object, prototype will be set to null where possible
     * @static
     * @private
     */
    exports.createNullProtoObjWherePossible = (function () {
        if (typeof Object.create == 'function') {
            return function () {
                return Object.create(null);
            };
        }
        if (!({__proto__: null} instanceof Object)) {
            return function () {
                return {__proto__: null};
            };
        }
        // Not possible, just pass through
        return function () {
            return {};
        };
    })();
    
    exports.hasOwnOnlyObject = function (obj) {
        var o = exports.createNullProtoObjWherePossible();
        for (var p in obj) {
            if (hasOwn(obj, p)) {
                o[p] = obj[p];
            }
        }
        return o;
    };
    
    
    },{}],3:[function(require,module,exports){
    
    },{}],4:[function(require,module,exports){
    (function (process){
    // .dirname, .basename, and .extname methods are extracted from Node.js v8.11.1,
    // backported and transplited with Babel, with backwards-compat fixes
    
    // Copyright Joyent, Inc. and other Node contributors.
    //
    // Permission is hereby granted, free of charge, to any person obtaining a
    // copy of this software and associated documentation files (the
    // "Software"), to deal in the Software without restriction, including
    // without limitation the rights to use, copy, modify, merge, publish,
    // distribute, sublicense, and/or sell copies of the Software, and to permit
    // persons to whom the Software is furnished to do so, subject to the
    // following conditions:
    //
    // The above copyright notice and this permission notice shall be included
    // in all copies or substantial portions of the Software.
    //
    // THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
    // OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
    // MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
    // NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
    // DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
    // OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
    // USE OR OTHER DEALINGS IN THE SOFTWARE.
    
    // resolves . and .. elements in a path array with directory names there
    // must be no slashes, empty elements, or device names (c:\) in the array
    // (so also no leading and trailing slashes - it does not distinguish
    // relative and absolute paths)
    function normalizeArray(parts, allowAboveRoot) {
        // if the path tries to go above the root, `up` ends up > 0
        var up = 0;
        for (var i = parts.length - 1; i >= 0; i--) {
            var last = parts[i];
            if (last === '.') {
                parts.splice(i, 1);
            } else if (last === '..') {
                parts.splice(i, 1);
                up++;
            } else if (up) {
                parts.splice(i, 1);
                up--;
            }
        }
    
        // if the path is allowed to go above the root, restore leading ..s
        if (allowAboveRoot) {
            for (; up--; up) {
                parts.unshift('..');
            }
        }
    
        return parts;
    }
    
    // path.resolve([from ...], to)
    // posix version
    exports.resolve = function() {
        var resolvedPath = '',
                resolvedAbsolute = false;
    
        for (var i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
            var path = (i >= 0) ? arguments[i] : process.cwd();
    
            // Skip empty and invalid entries
            if (typeof path !== 'string') {
                throw new TypeError('Arguments to path.resolve must be strings');
            } else if (!path) {
                continue;
            }
    
            resolvedPath = path + '/' + resolvedPath;
            resolvedAbsolute = path.charAt(0) === '/';
        }
    
        // At this point the path should be resolved to a full absolute path, but
        // handle relative paths to be safe (might happen when process.cwd() fails)
    
        // Normalize the path
        resolvedPath = normalizeArray(filter(resolvedPath.split('/'), function(p) {
            return !!p;
        }), !resolvedAbsolute).join('/');
    
        return ((resolvedAbsolute ? '/' : '') + resolvedPath) || '.';
    };
    
    // path.normalize(path)
    // posix version
    exports.normalize = function(path) {
        var isAbsolute = exports.isAbsolute(path),
                trailingSlash = substr(path, -1) === '/';
    
        // Normalize the path
        path = normalizeArray(filter(path.split('/'), function(p) {
            return !!p;
        }), !isAbsolute).join('/');
    
        if (!path && !isAbsolute) {
            path = '.';
        }
        if (path && trailingSlash) {
            path += '/';
        }
    
        return (isAbsolute ? '/' : '') + path;
    };
    
    // posix version
    exports.isAbsolute = function(path) {
        return path.charAt(0) === '/';
    };
    
    // posix version
    exports.join = function() {
        var paths = Array.prototype.slice.call(arguments, 0);
        return exports.normalize(filter(paths, function(p, index) {
            if (typeof p !== 'string') {
                throw new TypeError('Arguments to path.join must be strings');
            }
            return p;
        }).join('/'));
    };
    
    
    // path.relative(from, to)
    // posix version
    exports.relative = function(from, to) {
        from = exports.resolve(from).substr(1);
        to = exports.resolve(to).substr(1);
    
        function trim(arr) {
            var start = 0;
            for (; start < arr.length; start++) {
                if (arr[start] !== '') break;
            }
    
            var end = arr.length - 1;
            for (; end >= 0; end--) {
                if (arr[end] !== '') break;
            }
    
            if (start > end) return [];
            return arr.slice(start, end - start + 1);
        }
    
        var fromParts = trim(from.split('/'));
        var toParts = trim(to.split('/'));
    
        var length = Math.min(fromParts.length, toParts.length);
        var samePartsLength = length;
        for (var i = 0; i < length; i++) {
            if (fromParts[i] !== toParts[i]) {
                samePartsLength = i;
                break;
            }
        }
    
        var outputParts = [];
        for (var i = samePartsLength; i < fromParts.length; i++) {
            outputParts.push('..');
        }
    
        outputParts = outputParts.concat(toParts.slice(samePartsLength));
    
        return outputParts.join('/');
    };
    
    exports.sep = '/';
    exports.delimiter = ':';
    
    exports.dirname = function (path) {
        if (typeof path !== 'string') path = path + '';
        if (path.length === 0) return '.';
        var code = path.charCodeAt(0);
        var hasRoot = code === 47 /*/*/;
        var end = -1;
        var matchedSlash = true;
        for (var i = path.length - 1; i >= 1; --i) {
            code = path.charCodeAt(i);
            if (code === 47 /*/*/) {
                    if (!matchedSlash) {
                        end = i;
                        break;
                    }
                } else {
                // We saw the first non-path separator
                matchedSlash = false;
            }
        }
    
        if (end === -1) return hasRoot ? '/' : '.';
        if (hasRoot && end === 1) {
            // return '//';
            // Backwards-compat fix:
            return '/';
        }
        return path.slice(0, end);
    };
    
    function basename(path) {
        if (typeof path !== 'string') path = path + '';
    
        var start = 0;
        var end = -1;
        var matchedSlash = true;
        var i;
    
        for (i = path.length - 1; i >= 0; --i) {
            if (path.charCodeAt(i) === 47 /*/*/) {
                    // If we reached a path separator that was not part of a set of path
                    // separators at the end of the string, stop now
                    if (!matchedSlash) {
                        start = i + 1;
                        break;
                    }
                } else if (end === -1) {
                // We saw the first non-path separator, mark this as the end of our
                // path component
                matchedSlash = false;
                end = i + 1;
            }
        }
    
        if (end === -1) return '';
        return path.slice(start, end);
    }
    
    // Uses a mixed approach for backwards-compatibility, as ext behavior changed
    // in new Node.js versions, so only basename() above is backported here
    exports.basename = function (path, ext) {
        var f = basename(path);
        if (ext && f.substr(-1 * ext.length) === ext) {
            f = f.substr(0, f.length - ext.length);
        }
        return f;
    };
    
    exports.extname = function (path) {
        if (typeof path !== 'string') path = path + '';
        var startDot = -1;
        var startPart = 0;
        var end = -1;
        var matchedSlash = true;
        // Track the state of characters (if any) we see before our first dot and
        // after any path separator we find
        var preDotState = 0;
        for (var i = path.length - 1; i >= 0; --i) {
            var code = path.charCodeAt(i);
            if (code === 47 /*/*/) {
                    // If we reached a path separator that was not part of a set of path
                    // separators at the end of the string, stop now
                    if (!matchedSlash) {
                        startPart = i + 1;
                        break;
                    }
                    continue;
                }
            if (end === -1) {
                // We saw the first non-path separator, mark this as the end of our
                // extension
                matchedSlash = false;
                end = i + 1;
            }
            if (code === 46 /*.*/) {
                    // If this is our first dot, mark it as the start of our extension
                    if (startDot === -1)
                        startDot = i;
                    else if (preDotState !== 1)
                        preDotState = 1;
            } else if (startDot !== -1) {
                // We saw a non-dot and non-path separator before our dot, so we should
                // have a good chance at having a non-empty extension
                preDotState = -1;
            }
        }
    
        if (startDot === -1 || end === -1 ||
                // We saw a non-dot character immediately before the dot
                preDotState === 0 ||
                // The (right-most) trimmed path component is exactly '..'
                preDotState === 1 && startDot === end - 1 && startDot === startPart + 1) {
            return '';
        }
        return path.slice(startDot, end);
    };
    
    function filter (xs, f) {
            if (xs.filter) return xs.filter(f);
            var res = [];
            for (var i = 0; i < xs.length; i++) {
                    if (f(xs[i], i, xs)) res.push(xs[i]);
            }
            return res;
    }
    
    // String.prototype.substr - negative index don't work in IE8
    var substr = 'ab'.substr(-1) === 'b'
            ? function (str, start, len) { return str.substr(start, len) }
            : function (str, start, len) {
                    if (start < 0) start = str.length + start;
                    return str.substr(start, len);
            }
    ;
    
    }).call(this,require('_process'))
    },{"_process":5}],5:[function(require,module,exports){
    // shim for using process in browser
    var process = module.exports = {};
    
    // cached from whatever global is present so that test runners that stub it
    // don't break things.  But we need to wrap it in a try catch in case it is
    // wrapped in strict mode code which doesn't define any globals.  It's inside a
    // function because try/catches deoptimize in certain engines.
    
    var cachedSetTimeout;
    var cachedClearTimeout;
    
    function defaultSetTimout() {
            throw new Error('setTimeout has not been defined');
    }
    function defaultClearTimeout () {
            throw new Error('clearTimeout has not been defined');
    }
    (function () {
            try {
                    if (typeof setTimeout === 'function') {
                            cachedSetTimeout = setTimeout;
                    } else {
                            cachedSetTimeout = defaultSetTimout;
                    }
            } catch (e) {
                    cachedSetTimeout = defaultSetTimout;
            }
            try {
                    if (typeof clearTimeout === 'function') {
                            cachedClearTimeout = clearTimeout;
                    } else {
                            cachedClearTimeout = defaultClearTimeout;
                    }
            } catch (e) {
                    cachedClearTimeout = defaultClearTimeout;
            }
    } ())
    function runTimeout(fun) {
            if (cachedSetTimeout === setTimeout) {
                    //normal enviroments in sane situations
                    return setTimeout(fun, 0);
            }
            // if setTimeout wasn't available but was latter defined
            if ((cachedSetTimeout === defaultSetTimout || !cachedSetTimeout) && setTimeout) {
                    cachedSetTimeout = setTimeout;
                    return setTimeout(fun, 0);
            }
            try {
                    // when when somebody has screwed with setTimeout but no I.E. maddness
                    return cachedSetTimeout(fun, 0);
            } catch(e){
                    try {
                            // When we are in I.E. but the script has been evaled so I.E. doesn't trust the global object when called normally
                            return cachedSetTimeout.call(null, fun, 0);
                    } catch(e){
                            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error
                            return cachedSetTimeout.call(this, fun, 0);
                    }
            }
    
    
    }
    function runClearTimeout(marker) {
            if (cachedClearTimeout === clearTimeout) {
                    //normal enviroments in sane situations
                    return clearTimeout(marker);
            }
            // if clearTimeout wasn't available but was latter defined
            if ((cachedClearTimeout === defaultClearTimeout || !cachedClearTimeout) && clearTimeout) {
                    cachedClearTimeout = clearTimeout;
                    return clearTimeout(marker);
            }
            try {
                    // when when somebody has screwed with setTimeout but no I.E. maddness
                    return cachedClearTimeout(marker);
            } catch (e){
                    try {
                            // When we are in I.E. but the script has been evaled so I.E. doesn't  trust the global object when called normally
                            return cachedClearTimeout.call(null, marker);
                    } catch (e){
                            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error.
                            // Some versions of I.E. have different rules for clearTimeout vs setTimeout
                            return cachedClearTimeout.call(this, marker);
                    }
            }
    
    
    
    }
    var queue = [];
    var draining = false;
    var currentQueue;
    var queueIndex = -1;
    
    function cleanUpNextTick() {
            if (!draining || !currentQueue) {
                    return;
            }
            draining = false;
            if (currentQueue.length) {
                    queue = currentQueue.concat(queue);
            } else {
                    queueIndex = -1;
            }
            if (queue.length) {
                    drainQueue();
            }
    }
    
    function drainQueue() {
            if (draining) {
                    return;
            }
            var timeout = runTimeout(cleanUpNextTick);
            draining = true;
    
            var len = queue.length;
            while(len) {
                    currentQueue = queue;
                    queue = [];
                    while (++queueIndex < len) {
                            if (currentQueue) {
                                    currentQueue[queueIndex].run();
                            }
                    }
                    queueIndex = -1;
                    len = queue.length;
            }
            currentQueue = null;
            draining = false;
            runClearTimeout(timeout);
    }
    
    process.nextTick = function (fun) {
            var args = new Array(arguments.length - 1);
            if (arguments.length > 1) {
                    for (var i = 1; i < arguments.length; i++) {
                            args[i - 1] = arguments[i];
                    }
            }
            queue.push(new Item(fun, args));
            if (queue.length === 1 && !draining) {
                    runTimeout(drainQueue);
            }
    };
    
    // v8 likes predictible objects
    function Item(fun, array) {
            this.fun = fun;
            this.array = array;
    }
    Item.prototype.run = function () {
            this.fun.apply(null, this.array);
    };
    process.title = 'browser';
    process.browser = true;
    process.env = {};
    process.argv = [];
    process.version = ''; // empty string to avoid regexp issues
    process.versions = {};
    
    function noop() {}
    
    process.on = noop;
    process.addListener = noop;
    process.once = noop;
    process.off = noop;
    process.removeListener = noop;
    process.removeAllListeners = noop;
    process.emit = noop;
    process.prependListener = noop;
    process.prependOnceListener = noop;
    
    process.listeners = function (name) { return [] }
    
    process.binding = function (name) {
            throw new Error('process.binding is not supported');
    };
    
    process.cwd = function () { return '/' };
    process.chdir = function (dir) {
            throw new Error('process.chdir is not supported');
    };
    process.umask = function() { return 0; };
    
    },{}],6:[function(require,module,exports){
    module.exports={
        "name": "ejs",
        "description": "Embedded JavaScript templates",
        "keywords": [
            "template",
            "engine",
            "ejs"
        ],
        "version": "3.1.9",
        "author": "Matthew Eernisse <mde@fleegix.org> (http://fleegix.org)",
        "license": "Apache-2.0",
        "bin": {
            "ejs": "./bin/cli.js"
        },
        "main": "./lib/ejs.js",
        "jsdelivr": "ejs.min.js",
        "unpkg": "ejs.min.js",
        "repository": {
            "type": "git",
            "url": "git://github.com/mde/ejs.git"
        },
        "bugs": "https://github.com/mde/ejs/issues",
        "homepage": "https://github.com/mde/ejs",
        "dependencies": {
            "jake": "^10.8.5"
        },
        "devDependencies": {
            "browserify": "^16.5.1",
            "eslint": "^6.8.0",
            "git-directory-deploy": "^1.5.1",
            "jsdoc": "^4.0.2",
            "lru-cache": "^4.0.1",
            "mocha": "^10.2.0",
            "uglify-js": "^3.3.16"
        },
        "engines": {
            "node": ">=0.10.0"
        },
        "scripts": {
            "test": "npx jake test"
        }
    }
    
    },{}]},{},[1])(1)
    });
    
return module.exports;
}
if (typeof module !== 'undefined' && module.exports) module.exports = createEjsParserLibrary;
