// no npm!
const fs = require('fs')
const os = require('os')
const net = require('net')
const ini = require(__dirname + '/ini')
const lib = require(__dirname + '/lib')
const configUtil = require(__dirname + '/config')
const { spawn } = require('child_process')
//const stdin     = process.openStdin()

// to disable daemon mode for debugging
// sudo __daemon=1 node index.js

var pids = {}

function killStorageServer(config, running, pids) {
  if (config.storage.enabled && running.storageServer) {
    console.log('LAUNCHER: killing storage on', pids.storageServer)
    process.kill(pids.storageServer, 'SIGINT')
    running.storageServer = 0
  }
}

function killLokinetAndStorageServer(config, running, pids) {
  //console.log('LAUNCHER: old network', running.lokinet, pids.lokinet)
  //console.log('LAUNCHER: old storage', running.storageServer, pids.storageServer)
  killStorageServer(config, running, pids)
  // FIXME: only need to restart if the key changed
  if (config.network.enabled) {
    if (running.lokinet) {
      console.log('LAUNCHER: killing lokinet on', pids.lokinet)
      process.kill(pids.lokinet, 'SIGINT')
      running.lokinet = 0
    }
  }
}

module.exports = function(args, config, entryPoint) {
  const VERSION = 0.7

  //var logo = lib.getLogo('L A U N C H E R   v e r s i o n   v version')
  console.log('loki SN launcher version', VERSION, 'registered')
  const lokinet = require(__dirname + '/lokinet') // needed for checkConfig

  // preprocess command line arguments
  function parseXmrOptions() {
    var configSet = {}
    function setConfig(key, value) {
      if (configSet[key] !== undefined) {
        if (configSet[key].constructor.name == 'String') {
          if (configSet[key] != value) {
            configSet[key] = [configSet[key], value]
            //} else {
            // if just setting the same thing again then nothing to do
          }
        } else
        if (configSet[key].constructor.name == 'Boolean') {
          // likely a key without a value
          configSet[key] = value
        } else
          if (configSet[key].constructor.name == 'Array') {
            // FIXME: most array options should be unique...
            configSet[key].push(value)
          } else {
            console.warn('parseXmrOptions::setConfig - Unknown type', configSet[key].constructor.name)
          }
      } else {
        configSet[key] = value
      }
    }
    var last = null
    for (var i in args) {
      var arg = args[i]
      //console.log('arg', arg)
      if (arg.match(/^--/)) {
        var removeDashes = arg.replace(/^--/, '')
        if (arg.match(/=/)) {
          // key/value pairs
          var parts = removeDashes.split(/=/)
          var key = parts.shift()
          var value = parts.join('=')
          setConfig(key, value)
          last = null
        } else {
          // --stagenet
          setConfig(removeDashes, true)
          last = removeDashes
        }
      } else {
        // hack to allow equal to be optional..
        if (last != null) {
          console.log('should stitch together key', last, 'and value', arg, '?')
          setConfig(last, arg)
        }
        last = null
      }
    }
    return configSet
  }

  var xmrOptions = parseXmrOptions()
  console.log('Parsed command line options', xmrOptions)

  var requested_config = config

  configUtil.check(config)

  // normalize inputs (allow for more options but clamping it down internally)
  if (config.blockchain.network.toLowerCase() == "test" || config.blockchain.network.toLowerCase() == "testnet" || config.blockchain.network.toLowerCase() == "test-net") {
    config.blockchain.network = 'test'
  } else
    if (config.blockchain.network.toLowerCase() == "consensusnet" || config.blockchain.network.toLowerCase() == "consensus" || config.blockchain.network.toLowerCase() == "demo") {
      // it's called demo in the launcher because I feel strong this is the best label
      // we can reuse this for future demos as an isolated network
      config.blockchain.network = 'demo'
    } else
      if (config.blockchain.network.toLowerCase() == "staging" || config.blockchain.network.toLowerCase() == "stage") {
        config.blockchain.network = 'staging'
      }

  // autoconfig
  /*
  --zmq-rpc-bind-port arg (=22024, 38158 if 'testnet', 38155 if 'stagenet')
  --rpc-bind-port arg (=22023, 38157 if 'testnet', 38154 if 'stagenet')
  --p2p-bind-port arg (=22022, 38156 if 'testnet', 38153 if 'stagenet')
  --p2p-bind-port-ipv6 arg (=22022, 38156 if 'testnet', 38153 if 'stagenet')
  */
  // FIXME: map?
  if (config.blockchain.zmq_port == '0') {
    // only really need this one set for lokinet
    config.blockchain.zmq_port = undefined
    /*
    if (config.blockchain.network == 'test') {
      config.blockchain.zmq_port = 38158
    } else
    if (config.blockchain.network == "staging") {
      config.blockchain.zmq_port = 38155
    } else {
      config.blockchain.zmq_port = 22024
    }
    */
  }
  if (config.blockchain.p2p_port == '0') {
    // only really need this one set for lokinet
    config.blockchain.p2p_port = undefined
    /*
    if (config.blockchain.network == 'test') {
      config.blockchain.p2p_port = 38156
    } else
    if (config.blockchain.network == 'staging') {
      config.blockchain.p2p_port = 38153
    } else {
      config.blockchain.p2p_port = 22022
    }
    */
  }

  //
  // Disk Config needs to be locked by this point
  //

  // make sure data_dir has no trailing slash
  var blockchain_useDefaultDataDir = false

  function setupInitialBlockchainOptions() {
    // Merge in command line options
    if (xmrOptions['data-dir']) {
      if (blockchain_useDefaultDataDir) {
        // was default to load config and now it's set
        blockchain_useDefaultDataDir = false
      }
      var dir = xmrOptions['data-dir']
      config.blockchain.data_dir = dir
      // does this directory exist?
      if (!fs.existsSync(dir)) {
        console.warn('Configured data-dir [' + dir + '] does not exist, lokid will create it')
      }
    }
    // need these to set default directory
    if (xmrOptions['stagenet']) {
      config.blockchain.network = 'staging'
    } else
      if (xmrOptions['testnet']) {
        config.blockchain.network = 'test'
      }
  }

  setupInitialBlockchainOptions()

  // FIXME: convert getLokiDataDir to internal config value
  // something like estimated/calculated loki_data_dir
  // also this will change behavior if we actually set the CLI option to lokid
  if (!config.blockchain.data_dir) {
    console.log('using default data_dir, network', config.blockchain.network)
    config.blockchain.data_dir = os.homedir() + '/.loki'
    blockchain_useDefaultDataDir = true
  }
  config.blockchain.data_dir = config.blockchain.data_dir.replace(/\/$/, '')

  // data dir has to be set but should be before everything else
  if (xmrOptions['config-file']) {
    // read file in lokidata dir
    // FIXME: is it relative or absolute
    var filePath = xmrOptions['config-file']
    if (!fs.existsSync(filePath)) {
      var filePath2 = configUtil.getLokiDataDir(config) + '/' + xmrOptions['config-file']
      if (!fs.existsSync(filePath2)) {
        console.warn('Can\'t read config-file command line argument, files does not exist: ', [filePath, filePath2])
      } else {
        const moneroDiskConfig = fs.readFileSync(filePath2)
        const moneroDiskOptions = ini.iniToJSON(moneroDiskConfig.toString())
        console.log('parsed loki config', moneroDiskOptions.unknown)
        for (var k in moneroDiskOptions.unknown) {
          var v = moneroDiskOptions.unknown[k]
          xmrOptions[k] = v
        }
        // reprocess data-dir and network setings
        setupInitialBlockchainOptions()
      }
    } else {
      const moneroDiskConfig = fs.readFileSync(filePath)
      const moneroDiskOptions = ini.iniToJSON(moneroDiskConfig.toString())
      console.log('parsed loki config', moneroDiskOptions.unknown)
      for (var k in moneroDiskOptions.unknown) {
        var v = moneroDiskOptions.unknown[k]
        xmrOptions[k] = v
      }
      // reprocess data-dir and network setings
      setupInitialBlockchainOptions()
    }
  } else {
    // no config-file param but is there a config file...
    var defaultLokidConfigPath = configUtil.getLokiDataDir(config) + '/loki.conf'
    if (fs.existsSync(defaultLokidConfigPath)) {
      const moneroDiskConfig = fs.readFileSync(defaultLokidConfigPath)
      const moneroDiskOptions = ini.iniToJSON(moneroDiskConfig.toString())
      console.log('parsed loki config', moneroDiskOptions.unknown)
      for (var k in moneroDiskOptions.unknown) {
        var v = moneroDiskOptions.unknown[k]
        xmrOptions[k] = v
      }
      // reprocess data-dir and network setings
      setupInitialBlockchainOptions()
    }
  }
  // handle merging remaining launcher options
  if (xmrOptions['rpc-login']) {
    if (xmrOptions['rpc-login'].match(/:/)) {
      var parts = xmrOptions['rpc-login'].split(/:/)
      var user = parts.shift()
      var pass = parts.join(':')
      config.blockchain.rpc_user = user
      config.blockchain.rpc_pass = pass
    } else {
      console.warn('Can\'t read rpc-login command line argument', xmrOptions['rpc-login'])
    }
  }
  // rpc_ip
  if (xmrOptions['rpc-bind-ip']) {
    // any way to validate this string?
    config.blockchain.rpc_ip = xmrOptions['rpc-bind-ip']
  }
  function setPort(cliKey, configKey, subsystem) {
    if (subsystem === undefined) subsystem = 'blockchain'
    if (xmrOptions[cliKey]) {
      var test = parseInt(xmrOptions[cliKey])
      if (test) {
        config[subsystem][configKey] = xmrOptions[cliKey]
      } else {
        console.warn('Can\'t read', cliKey, 'command line argument', xmrOptions[cliKey])
      }
    }
  }
  setPort('zmq-rpc-bind-port', 'zmq_port')
  setPort('rpc-bind-port', 'rpc_port')
  setPort('p2p-bind-port', 'p2p_port')

  // launcher defaults
  // only thing you can't turn off is blockchain (lokid)
  // if you have storage without lokinet, it will use the public IP to serve on
  // we will internally change these defaults over time
  // users are not encourage (currently) to put these in their INI (only loki devs)
  if (config.network.enabled === undefined) {
    config.network.enabled = false
  }
  if (config.storage.enabled === undefined) {
    config.storage.enabled = false
  }

  // lokinet defaults
  if (config.network.testnet === undefined) {
    config.network.testnet = config.blockchain.network == "test" || config.blockchain.network == "demo"
  }
  if (config.network.testnet && config.network.netid === undefined) {
    if (config.blockchain.network == "demo") {
      config.network.netid = "demonet"
    }
  }
  // FIXME: maybe this should be inside the lokinet library...
  if (config.network.data_dir) {
    // lokid
    //ident-privkey=/Users/admin/.lokinet/identity.private
    // not lokig
    //transport-privkey=/Users/admin/.lokinet/transport.private
    //encryption-privkey=/Users/admin/.lokinet/encryption.private
    config.network.transport_privkey = config.network.data_dir + '/transport.private'
    config.network.encryption_privkey = config.network.data_dir + '/encryption.private'
    config.network.ident_privkey = config.network.data_dir + '/identity.private'
    config.network.contact_file = config.network.data_dir + '/self.signed'
  }
  lokinet.checkConfig(config.network) // can auto-configure network.binary_path
  // storage server auto config
  if (config.storage.lokid_key === undefined) {
    config.storage.lokid_key = configUtil.getLokiDataDir(config) + '/key'
  }
  config.storage.lokid_rpc_port = config.blockchain.rpc_port

  // lokid config and most other configs should be locked into stone by this point
  // (except for lokinet, since we need to copy lokid over to it)

  console.log('Launcher running config:', config)
  /*
  var col1 = []
  var col2 = []
  for(var k in config.blockchain) {
    col1.push(k)
    col2.push(config.blockchain[k])
  }
  var col3 = []
  var col4 = []
  for(var k in config.network) {
    col3.push(k)
    col4.push(config.network[k])
  }
  var maxRows = Math.max(col1.length, col3.length)
  for(var i = 0; i < maxRows; ++i) {
    var c1 = '', c2 = '', c3 = '', c4 = ''
    if (col1[i] !== undefined) c1 = col1[i]
    if (col2[i] !== undefined) c2 = col2[i]
    if (col3[i] !== undefined) c3 = col3[i]
    if (col4[i] !== undefined) c4 = col4[i]
    var c2chars = 21
    if (c4.length > c2chars) {
      var diff = c4.length - 29 + 4 // not sure why we need + 4 here...
      var remaining = c2chars - c2.length
      //console.log('diff', diff, 'remaining', remaining)
      if (remaining > 0) {
        if (remaining >= diff) {
          c2chars -= diff
          //console.log('padding 2 to', c2chars)
        }
      }
    }
    console.log(c1.padStart(11, ' '), c2.padStart(c2chars, ' '), c3.padStart(11, ' '), c4.padStart(27, ' '))
  }
  console.log('storage config', config.storage)
  */

  // upload final lokid to lokinet
  config.network.lokid = config.blockchain

  //
  // Config is now set in stone
  //

  //console.log(logo.replace(/version/, VERSION.toString().split('').join(' ')))


  //
  // run all sanity checks
  //

  if (!fs.existsSync(config.blockchain.binary_path)) {
    console.error('lokid is not at configured location', config.blockchain.binary_path)
    process.exit(1)
  }
  if (config.storage.enabled) {
    if (!fs.existsSync(config.storage.binary_path)) {
      console.error('storageServer is not at configured location', config.storage.binary_path)
      process.exit(1)
    }
  }
  if (config.network.enabled) {
    if (!fs.existsSync(config.network.binary_path)) {
      console.error('lokinet is not at configured location', config.network.binary_path)
      process.exit(1)
    }

    if (config.network.bootstrap_path && !fs.existsSync(config.network.bootstrap_path)) {
      console.error('lokinet bootstrap not found at location', config.network.binary_path)
      process.exit(1)
    }
  }
  // isn't create until lokid runs
  /*
  if (!fs.existsSync(config.storage.lokid_key)) {
    console.error('lokid key not found at location', config.storage.lokid_key)
    process.exit()
  }
  */

  if (!config.launcher.var_path) {
    console.error('no var_path set')
    process.exit(1)
  }

  if (!fs.existsSync(config.launcher.var_path)) {
    // just make sure this directory exists
    // FIXME: maybe skip if root...
    console.log('making', config.launcher.var_path)
    lokinet.mkDirByPathSync(config.launcher.var_path)
  }

  // make sure the binary_path that exists are not a directory
  if (fs.lstatSync(config.blockchain.binary_path).isDirectory()) {
    console.error('lokid configured location is a directory', config.blockchain.binary_path)
    process.exit(1)
  }
  if (config.storage.enabled) {
    if (fs.lstatSync(config.storage.binary_path).isDirectory()) {
      console.error('storageServer configured location is a directory', config.storage.binary_path)
      process.exit(1)
    }
  }
  if (config.network.enabled) {
    if (fs.lstatSync(config.network.binary_path).isDirectory()) {
      console.error('lokinet configured location is a directory', config.network.binary_path)
      process.exit(1)
    }

    if (config.network.bootstrap_path && fs.lstatSync(config.network.bootstrap_path).isDirectory()) {
      console.error('lokinet bootstrap configured location is a directory', config.network.binary_path)
      process.exit(1)
    }
  }
  if (config.storage.enabled) {
    if (fs.existsSync(config.storage.lokid_key) && fs.lstatSync(config.storage.lokid_key).isDirectory()) {
      console.error('lokid key location is a directory', config.storage.lokid_key)
      process.exit(1)
    }

    if (config.storage.db_location !== undefined) {
      if (fs.existsSync(config.storage.db_location)) {
        if (!fs.lstatSync(config.storage.db_location).isDirectory()) {
          console.error('storage server db_location is not a directory', config.storage.db_location)
          process.exit(1)
        } // else perfect
      } // else we'll make
    } // else we'll just current dir
  }

  //console.log('userInfo', os.userInfo('utf8'))
  //console.log('started as', process.getuid(), process.geteuid())
  if (os.platform() == 'darwin') {
    if (process.getuid() != 0) {
      console.error('MacOS requires you start this with sudo')
      process.exit(1)
    }
  } else {
    if (process.getuid() == 0) {
      console.error('Its not recommended you run this as root')
    }
  }

  //
  // get processes state
  //

  // are we already running
  var pid = lib.areWeRunning(config)
  if (pid) {
    console.log('LAUNCHER: loki launcher already active under', pid)
    process.exit()
  }

  pids = lib.getPids(config)
  var running = lib.getProcessState(config)

  function isNothingRunning(running) {
    return !(running.lokid || running.lokinet || running.storageServer)
  }

  // progress to 2nd phase where we might need to start something
  const daemon = require(__dirname + '/daemon')
  daemon.config = config // update config for shutdownEverything

  function startEverything(config, args) {
    for (var i in args) {
      // should we prevent --non-interactive?
      // probably not, if they want to run it that way, why not support it?
      var arg = args[i]
      if (arg == '--non-interactive') {
        // inform launcher to work like they desire
        config.launcher.docker = true
      }
    }

    // to debug
    // sudo __daemon=1 node index.js
    //daemon(args, __filename, lokinet, config, getLokiDataDir)
    var foregroundIt = config.launcher.interactive || !lib.falsish(config.launcher.docker)
    //console.log('LAUNCHER: startEverything - foreground?', foregroundIt)
    daemon.startLauncherDaemon(config, foregroundIt, entryPoint, args, function() {
      // start the lokinet prep
      daemon.startLokinet(config, args, function(started) {
        //console.log('StorageServer now running', started)
        if (!started) {
          daemon.shutdown_everything()
        }
      })
      daemon.startLokid(config, args)
    })
  }

  //
  // normalize state
  //

  // kill what needs to be killed

  // storage needs it's lokinet, kill any strays
  if (config.network.enabled && config.storage.enabled) {
    // FIXME: clearnet support?
    if (!running.lokinet && running.storageServer) {
      console.log('LAUNCHER: we have storage server with no lokinet, killing it', pids.storageServer)
      process.kill(pids.storageServer, 'SIGINT')
      running.storageServer = 0
    }
    // FIXME if just blockchain and storage server, should we restart the storage if lokid dies?
  }

  if (!config.network.enabled && config.storage.enabled && !running.lokid) {
    console.log('LAUNCHER: we have storage server with no lokid', pids.storageServer)
    // no need to kill it in clearnet mode
    /*
    process.kill(pids.storageServer, 'SIGINT')
    running.storageServer = 0
    */
  }

  if (config.network.enabled && !running.lokid) {
    // no lokid, kill remaining
    console.log('LAUNCHER: lokid is down, kill idlers')
    killLokinetAndStorageServer(config, running, pids)
  }

  if (!pids.loki) {
    // no pid on disk or it's running
    var useConfig = config
    if (pids.runningConfig) useConfig = pids.runningConfig
    lokinet.portIsFree(useConfig.blockchain.rpc_ip, useConfig.blockchain.rpc_port, function(portFree) {
      console.log('rpc:', useConfig.blockchain.rpc_ip + ':' + useConfig.blockchain.rpc_port, 'status', portFree?'not running':'running')
      if (!portFree) {
        console.log('')
        console.log('There\'s a lokid that we\'re not tracking using our configuration. You likely will want to confirm and manually stop it before start using the launcher again. Exiting...')
        console.log('')
        // no pids.json will exist... and not easy to fake one
        daemon.shutdown_everything()
      } else {
        // port is open
        if (isNothingRunning(running)) {
          console.log("LAUNCHER: Starting fresh copy of Loki Suite")
          startEverything(config, args)
          return
        }
        // we can't go into recovery mode if there's no lokid
      }
    })
    return
  }
  if (isNothingRunning(running)) {
    console.log("LAUNCHER: Starting fresh copy of Loki Suite")
    startEverything(config, args)
    return
  }

  //
  // go into recovery mode
  //

  // ignore any configuration of current
  if (pids.config) {
    //console.log('replacing config with running config', pids.config)
    config = pids.config
    args = pids.args
  }

  // adopt responsibility of watching the existing suite
  function launcherRecoveryMonitor(config) {
    var pids = lib.getPids(config)

    // concern: what if it's running but quitting
    // our timer will catch this
    // concern: what if lokinet/storage is restarted elsewhere
    // it won't because we've already ensured we're the only launcher for this
    if (!pids.lokid || !lib.isPidRunning(pids.lokid)) {
      if (pids.lokid) {
        console.log('LAUNCHER: lokid just died', pids.lokid)
      } else {
        // pids file was just cleared...
      }
      // no launcher, so we may need to do someclean up
      // lokid needs no clean up
      // kill storageServer and lokinet?
      // FIXME: only need to if key changes...
      //
      // if existed previous / if we started them
      // we can't make a pids into the started style
      // so we'll have to just update from disk
      //pids = lib.getPids(config)
      running = lib.getProcessState(config)   // update locations of lokinet/storageServer
      killLokinetAndStorageServer(config, running, pids) // kill them
      // and restart it all?
      if (config.blockchain.restart) {
        startEverything(config, args)
      } else {
        // so we don't want to restart lokid but we can't find that it is running
        // but all we really know is we stopped tracking the pid
        // ctrl-c could have cleared it...
        // shutdown the launcher properly
        daemon.shutdown_everything()
      }
    } else {
      //console.log('watching lokid, will reclaim control when it restarts')
      if (!pids.lokinet || !lib.isPidRunning(pids.lokinet)) {
        // kill storage server
        killStorageServer(config, running, pids)
        // well assuming old lokid is still running
        daemon.startLokinet(config, shutdownIfNotStarted)
      } else
        if (!pids.storageServer ||!lib.isPidRunning(pids.storageServer)) {
          daemon.startStorageServer(config, args, shutdownIfNotStarted)
        }
    }
    // as long as there's something to monitor
    if (pids.lokid || pids.lokinet || pids.storageServer) {
      setTimeout(function() {
        launcherRecoveryMonitor(config)
      }, 15 * 1000)
    }
    // otherwise let go of the last handle so we can exit...
  }

  function shutdownIfNotStarted(started) {
    if (!started) {
      daemon.shutdown_everything()
    }
  }

  // figure out how to recover state with a running lokid
  if (config.network.enabled && !running.lokinet) {
    // start lokinet
    // therefore starting storageServer
    daemon.startLokinet(config, args, shutdownIfNotStarted)
  } else
    if (config.storage.enabled && !running.storageServer) {
      // start storageServer
      daemon.startStorageServer(config, args, shutdownIfNotStarted)
    }

  // we need start watching everything all over again
  launcherRecoveryMonitor(config)

  // well now register ourselves as the proper guardian of the suite
  lib.setStartupLock(config)

  // handle handlers...
  daemon.setupHandlers()

  // so we won't have a console for the socket to connect to
  // should we run an empty server and let them know?
  // well we can only send a message and we can do that on the client side
}
