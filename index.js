/**********************************************************************
 * Copyright 2020 Paul Reeve <preeve@pdjr.eu>
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you
 * may not use this file except in compliance with the License. You may
 * obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
 * implied. See the License for the specific language governing
 * permissions and limitations under the License.
 */

const bacon = require("baconjs");
const fs = require('fs');
const RrdClient = require('./lib/librrdclient/RrdClient.js');
const KellyColors = require("./lib/libkellycolors/KellyColors.js");
const Schema = require("./lib/signalk-libschema/Schema.js");
const Log = require("./lib/signalk-liblog/Log.js");
const DebugLog = require("./lib/signalk-liblog/DebugLog.js");

const PLUGIN_SCHEMA_FILE = __dirname + "/schema.json";
const PLUGIN_UISCHEMA_FILE = __dirname + "/uischema.json";
const APP_CONFIGURATION_FILE = __dirname + "/config.json";
const DEBUG_KEYS = [ "rrd" ];

module.exports = function(app) {
  var plugin = {};
  var unsubscribes = [];
  var switchbanks = {};

  plugin.id = "tankmonitor";
  plugin.name = "Tank monitor";
  plugin.description = "Monitor tank levels.";

  const kellycolors = new KellyColors();
  const log = new Log(plugin.id, { ncallback: app.setPluginStatus, ecallback: app.setPluginError });
  const debug = new DebugLog(plugin.id, DEBUG_KEYS);

  plugin.schema = function() {
    var schema = Schema.createSchema(PLUGIN_SCHEMA_FILE);
    return(schema.getSchema());
  };

  plugin.uiSchema = function() {
    var schema = Schema.createSchema(PLUGIN_UISCHEMA_FILE);
    return(schema.getSchema());
  }

  plugin.start = function(options) {
    fs.writeFileSync(APP_CONFIGURATION_FILE, JSON.stringify(options));
    if (options.rrdenabled) {
      log.N("time-series logging enabled");
      var tankPaths = options.tweaks.filter(t => ((!t.ignore) && (t.log))).map(t => (t.path + ".currentLevel"));
      if (tankPaths.length > 0) {
        log.N("logging %d data channels", tankPaths.length);
        var rrdclient = new RrdClient((debug.enabled('rrd'))?{ debug: false }:{});
        var dbname = plugin.id + ".rrd";
        var dbpathname = (options.rrdfolder.startsWith('/')?options.rrdfolder:(__dirname + "/" + options.rrdfolder)) + dbname;;
        var nowSeconds = Math.floor(Date.now() / 1000);
        if (options.rrdcstring) log.N("connecting to RRD cache daemon on %s", options.rrdcstring);
        rrdclient.connect(options.rrdcstring, (d) => { debug.N("rrd", "%s", d); }).then(
          (socket) => {
            var step = options.rrdtool.create.options.reduce((a,v) => ((v.name == "-s")?v.value:a), null) || 60;
            var heartbeat = (step * 2);
            var dsdefs = tankPaths.map(p => { return("DS:" + dsName(p, options.tweaks) + ":GAUGE:" + heartbeat + ":0:100"); });
            rrdclient.create(dbname, options.rrdtool.create.options, dsdefs, options.rrdtool.create.rradefs).then(
              () => {
                var stream = bacon.zipAsArray(tankPaths.map(p => app.streambundle.getSelfStream(p))).debounceImmediate(step * 1000);
                var updatecnt = 0;
                unsubscribes.push(stream.onValue(v => {
                  rrdclient.update(dbname, v.map(x => Math.floor((x * 100) + 0.5))).then(() => { }, () => { });
                  var graphs = options.rrdtool.graph.graphs.filter(g => (!(updatecnt % g.step)));
                  if (graphs.length) {
                    rrdclient.flush(dbname).then(
                      () => {
                        graphs.forEach(graphdef => {
                          var pathname = __dirname + "/" + options.rrdtool.graph.folder + graphdef.filename;
                          var args = graphArgs(graphdef, options.rrdtool.graph.options, tankPaths, options.tweaks, dbpathname, kellycolors.reset());
                          rrdclient.graph(pathname, args).then(
                            () => { debug.N("rrd", "success generating graph (%s)", JSON.stringify(graphdef)); },
                            () => { debug.N("rrd", "error generating graph (%s)", JSON.stringify(graphdef)); }
                          );
                        });
                      },
                      () => { }
                    );
                  }
                  updatecnt++;
                }));
              },
              () => { log.N("create database failed"); }
            );
          },
          () => { log.N("cannot connect to RRD cache daemon on %s", cstring); }
        );
      } else {
        log.W("time-series logging is enabled, but no log streams are configured");
      }
    } else {
      log.N("time-series logging disabled by configuration setting");
    }
  }

  plugin.stop = function() {
	unsubscribes.forEach(f => f());
    var unsubscribes = [];
  }

  function dsName(path, tweaks) {
    var tweak = getTweak(path, tweaks);
    var parts = path.split('.');
    return("T" + ((parts[2].length == 1)?"0":"") + parts[2] + ((tweak.name)?tweak.name:parts[1]));
  }

  function getTweak(path, tweaks) { 
    var retval = tweaks.sort((a,b) => (a.path === undefined)?-1:((b.path === undefined)?+1:(a.path.length - b.path.length))).reduce((a, v) => {
      if ((v.path == undefined) || path.startsWith(v.path)) {
        Object.keys(v).filter(k => (k != 'path')).forEach(k => { a[k] = v[k]; });
      }
      return(a);
    }, {});
    return(retval);
  }

  function graphArgs(graphdef, options, paths, tweaks, dbname, kellycolors) {
    var args = [];

    graphdef.DATE = (new Date()).toISOString();
    options.forEach(option => {
      args.push(option.name);
      args.push(replaceTokens(option.value, graphdef));
    });
      
    paths.map(p => dsName(p, tweaks)).forEach(dsName => {
      args.push("DEF:" + dsName  + "=" + dbname + ":" + dsName + ":AVERAGE");
      args.push("VDEF:" + dsName + "min=" + dsName + ",MINIMUM");
      args.push("VDEF:" + dsName + "max=" + dsName + ",MAXIMUM");
      args.push("VDEF:" + dsName + "avg=" + dsName + ",AVERAGE");
      args.push("VDEF:" + dsName + "lst=" + dsName + ",LAST");
    });

    args.push("COMMENT:'" + "Data source".padEnd(23,' ') + "'");
    args.push("COMMENT:'" + "Min".padEnd(10,' ') + "'");
    args.push("COMMENT:'" + "Max".padEnd(10,' ') + "'");
    args.push("COMMENT:'" + "Average".padEnd(10,' ') + "'");
    args.push("COMMENT:'" + "Last".padEnd(10,' ') + "'");
    args.push("COMMENT:'\\n'");

    paths.forEach(p => {
      var tweak = getTweak(p, tweaks);
      var dsname = dsName(p, tweaks);
      var color = (tweak.color.split(',').length == 2)?tweak.color.split(',')[1]:kellycolors.getColor();
      args.push("LINE1:" + dsname + color + ":'" + dsname.padEnd(13) + "'");
      args.push("GPRINT:" + dsname + "min:'%10.0lf'");
      args.push("GPRINT:" + dsname + "max:'%10.0lf'");
      args.push("GPRINT:" + dsname + "avg:'%10.0lf'");
      args.push("GPRINT:" + dsname + "lst:'%10.0lf'");
      args.push("COMMENT:'\\n'");
    });
    return(args);
  }
 
  function replaceTokens(string, tokens) {
    Object.keys(tokens).forEach(token => { string = string.replace("{" + token + "}", tokens[token]); });
    return(string);
  }

  return(plugin);
}
