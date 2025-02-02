#!/usr/bin/env node
// no npm!
const os = require('os')
const VERSION = 0.8

if (os.platform() == 'darwin') {
  if (process.getuid() != 0) {
    console.error('MacOS requires you start this with sudo, i.e. $ sudo ' + __filename)
    process.exit()
  }
} else {
  // FIXME:
  // ok if you run this once as root, it may create directories as root
  // maybe we should never make dirs as root... (unless macos, ugh)
}

// preprocess command line arguments
var args = JSON.parse(JSON.stringify(process.argv))
function stripArg(match) {
  var found = false
  for (var i in args) {
    var arg = args[i]
    if (arg == match) {
      args.splice(i, 1)
      found = true
    }
  }
  return found
}
// well argvs[0] we will always want to strip...
stripArg('/usr/local/bin/node')
stripArg('/usr/local/bin/nodejs')
stripArg('/usr/bin/node')
stripArg('/usr/bin/nodejs')
stripArg('node')
stripArg('nodejs')
stripArg(__filename) // will just be index.js
stripArg('loki-launcher')
stripArg('/usr/bin/loki-launcher')
stripArg('/usr/local/bin/loki-launcher')
// how is this not __filename??
stripArg('/usr/lib/node_modules/loki-launcher/index.js')
//console.debug('index filename:', __filename)
//console.debug('Launcher arguments:', args)

function findFirstArgWithoutDash() {
  for(var i in args) {
    var arg = args[i]
    //console.log('arg is', arg)
    if (arg.match(/^-/)) continue
    //console.log('command', arg)
    return arg
  }
  return ''
}

// find the first arg without --
var mode = findFirstArgWithoutDash()

//console.log('mode', mode)
stripArg(mode)
mode = mode.toLowerCase() // make sure it's lowercase

// load config from disk
const fs = require('fs')
const ini = require(__dirname + '/ini')
const configUtil = require(__dirname + '/config')
// FIXME: get config dir
// via cli param
// via . ?
var disk_config = {}
var config = configUtil.getDefaultConfig(__filename)
var config_type = 'default'
if (fs.existsSync('/etc/loki-launcher/launcher.ini')) {
  const ini_bytes = fs.readFileSync('/etc/loki-launcher/launcher.ini')
  disk_config = ini.iniToJSON(ini_bytes.toString())
  config = disk_config
  config_type = 'etc'
}
// local overrides default path
//console.log('test', __dirname + '/launcher.ini')
if (fs.existsSync(__dirname + '/launcher.ini')) {
  const ini_bytes = fs.readFileSync(__dirname + '/launcher.ini')
  disk_config = ini.iniToJSON(ini_bytes.toString())
  config = disk_config
  config_type = __dirname
}
config.type = config_type
configUtil.check(config)

const lib = require(__dirname + '/lib')

//console.log('Launcher config:', config)
var logo = lib.getLogo('L A U N C H E R   v e r s i o n   v version')
console.log(logo.replace(/version/, VERSION.toString().split('').join(' ')))

function warnRunAsRoot() {
  if (os.platform() != 'darwin') {
    if (process.getuid() == 0) {
      console.error('Its not recommended you run this as root unless the guide otherwise says to do so')
    }
  }
}

switch(mode) {
  case 'start': // official
    warnRunAsRoot()
    require(__dirname + '/start')(args, config, __filename)
  break;
  case 'status': // official
    const lokinet = require('./lokinet')
    var running = lib.getProcessState(config)
    if (running.lokid === undefined) {
      //console.log('no pids...')
      var pid = lib.areWeRunning(config)
      var pids = lib.getPids(config)
      if (pids.err == 'noFile'  && pid) {
        console.log('Launcher is running with no', config.launcher.var_path + '/pids.json, giving it a little nudge, please run status again, current results maybe incorrect')
        process.kill(pid, 'SIGHUP')
      }
    }
    // "not running" but too easy to confuse with "running"
    lib.getLauncherStatus(config, lokinet, 'offline', function(running, checklist) {
      var nodeVer = Number(process.version.match(/^v(\d+\.\d+)/)[1])
      //console.log('nodeVer', nodeVer)
      if (nodeVer >= 10) {
        console.table(checklist)
      } else {
        console.log(checklist)
      }
    })
    if (running.lokid) {
      // read config, run it with status param...
      // spawn out and relay output...
      // could also use the socket to issue a print_sn_status
    }
  break;
  case 'stop': // official
    console.log('Getting launcher state')
    var pid = lib.areWeRunning(config)
    if (pid) {
      // request launcher stop
      console.log('requesting launcher stop')
      process.kill(pid, 'SIGINT')
      // we quit too fast
      //require(__dirname + '/client')(config)
    } else {
      var running = lib.getProcessState(config)
      var pids = lib.getPids(config)
      if (running.lokid) {
        process.kill(pids.lokid, 'SIGINT')
      }
      if (config.storage.enabled && running.storageServer) {
        process.kill(pids.storageServer, 'SIGINT')
      }
      if (config.network.enabled && running.lokinet) {
        process.kill(pids.lokinet, 'SIGINT')
      }
    }
    function shutdownMonitor() {
      var running = lib.getProcessState(config)
      var pid = lib.areWeRunning(config)
      var waiting = []
      if (pid) {
        waiting.push('launcher')
      }
      if (running.lokid) {
        waiting.push('blockchain')
      }
      if (running.lokinet) {
        waiting.push('network')
      }
      if (running.storageServer) {
        waiting.push('storage')
      }
      if (running.lokid || running.lokinet || running.storageServer) {
        console.log('shutdown waiting on', waiting.join(' '))
        setTimeout(shutdownMonitor, 1000)
      } else {
        console.log('successfully shutdown')
      }
    }
    var running = lib.getProcessState(config)
    var wait = 500
    if (running.lokid) wait += 4500
    if (running.lokid || running.lokinet || running.storageServer) {
      console.log('waiting for daemons to stop')
      setTimeout(shutdownMonitor, wait)
    }
  break;
  case 'daemon-start': // official
    // debug mode basically (but also used internally now)
    // how this different from systemd-start?
    // this allows for interactive mode...
    process.env.__daemon = true
    require(__dirname + '/start')(args, config, __filename)
  break;
  case 'systemd-start': // official
    // stay in foreground mode...
    // force docker mode...
    // somehow I don't like this hack...
    // what we if reload config from disk...
    config.launcher.docker = true
    process.env.__daemon = true
    require(__dirname + '/start')(args, config, __filename)
  break;
  case 'config-build': // official
    // build a default config
    // commit it to disk if it doesn't exist
  break;
  case 'config-view': // official
    console.log('loki-launcher is in', __dirname)
    // FIXME: prettyPrint
    console.log('Launcher stored-config:', config)
    var pids = lib.getPids(config)
    if (pids && pids.runningConfig) {
      console.log('Launcher running-config:', pids.runningConfig)
    }
  break;
  case 'config-edit': // official
    // xdg-open / open ?
  break;
  case 'client': // deprecated
  case 'console': // official
    // enable all 3
  case 'blockchain':
    require(__dirname + '/client')(config)
  break;
  case 'prequal': // official
    require(__dirname + '/modes/prequal')(config, false)
  break;
  case 'prequal-debug': // official
    require(__dirname + '/modes/prequal')(config, true)
  break;
  case 'bwtest':
  case 'bw-test': // official
    require(__dirname + '/modes/bw-test').start(config, false)
  break;
  case 'bw-test-debug': // official
    require(__dirname + '/modes/bw-test').start(config, true)
  break;
  case 'check-systemd':
  case 'upgrade-systemd': // official
    require(__dirname + '/check-systemd').start(config, __filename)
  break;
  case 'chown':
  case 'fixperms':
  case 'fix-perms': // official
    var user = findFirstArgWithoutDash()
    require(__dirname + '/modes/fix-perms').start(user, __dirname, config)
  break;
  case 'args-debug': // official
    console.log('in :', process.argv)
    console.log('out:', args)
  break;
  case 'download-binaries': // official
    require(__dirname + '/modes/download-binaries').start(config)
  break;
  case 'help': // official
  case 'hlep':
  case 'hepl':
  case 'lpeh':
  default:
    console.debug('in :', process.argv)
    console.debug('out:', args)
    console.log(`
Unknown mode [${mode}]

loki-launcher is manages the Loki.network suite of software primarily for service node operation
Usage:
  loki-launcher [mode] [OPTIONS]

  Modes:
    start   start the loki suite with OPTIONS
    status  get the current loki suite status
    client  connect to lokid
    prequal prequalify your server for service node operation
    download-binaries download the latest version of the loki software suite
    check-systemd upgrade your lokid.service to use the launcher (requires root)
    fix-perms requires user OPTION, make all operational files own by user passed in
    config-view print out current configuration information
`)
  break;
}
