var CupolaServer = function() {
	
	var mPredictDt = 0.045;	// default is 0.03 seconds -- says how far to look-ahead when getting orientation
													// higher values can offset lag, but can also lead to jerky acceleration/deceleration

	var mDebugEnabled = false;

	if (!chrome.permissions) {
		console.error("CupolaServer: Requires chrome.permissions API");
		return null;
	}
	if (!chrome.usb) {
		console.error("CupolaServer: Requires chrome.usb API");
		return null;
	}

	var RIFT_VENDOR_ID = 10291;
	var RIFT_PRODUCT_ID = 1;
	var DEVICE_INFO = {"vendorId": RIFT_VENDOR_ID, "productId": RIFT_PRODUCT_ID};

	var KEEP_ALIVE_INTERVAL = 10000;

	var mPermissionObj = {permissions: [{'usbDevices': [DEVICE_INFO] }]};
	var mHasPermission = false;

	var mRiftConnectionHandle;

	var mKeepAliveIntervalId;

	var mConnected = true;

	var mRunning = false;

	var mDevicesJson;
	var mProfilesJson;

	var mTrackerMessage;
	var mSensorFusion;
	resetSensors();

	function resetSensors() {
		mTrackerMessage = new TrackerMessage();
		mSensorFusion = new SensorFusion();

		if (mDevicesJson) {
			mSensorFusion.loadMagCalibration("default", mDevicesJson);
		}
	}


	//-----------------------------

	function onWorkerError(e) {
		console.log('WORKER ERROR: line ' + e.lineno + ' in ' + e.filename + ': ' + e.message);
	}

	function onWorkerMessage(e) {
		var data = e.data;

		switch (data.cmd) {
			case 'log':
				console.log('Worker said: [' + data.msg + ']');
				break;
			case 'quat':
				console.log('Received a quat from worker: ' + JSON.stringify(data));

				updateQuatLabel(data);

				if (mRunning) {
					setTimeout(pollRiftSensors, 0);
					//mRunning = false;
				}

				break;
			default:
				console.error('Unknown command: ' + data.msg);
		}
	}

	//-----------------------------

	// http://www.usb.org/developers/devclass_docs/HID1_11.pdf from page 51
  // 0x21   => Send direction
  // 0x09   => Set_Report request
  // 0x0308 => Report Type Feature 0x03 << 8 | Report ID 0x08 (keep alive)
  var mKeepAliveCommand = 0;
	var mKeepAliveTransferInfo = {
    "requestType": "class",
    "recipient": "device",
    "direction": "out",
    "request": 0x09,
    "value": 0x0308,
    "index": 0,
    "data": new Uint8Array([
        8,
        mKeepAliveCommand & 0xFF,
        mKeepAliveCommand >> 8,
        KEEP_ALIVE_INTERVAL & 0xFF,
        KEEP_ALIVE_INTERVAL >> 8
      ]).buffer
  };

	//-----------------------------

	var sendKeepAliveCompleted = function(usbEvent) {
		if (chrome.runtime.lastError) {
	    console.error("sendKeepAliveCompleted Error:", chrome.runtime.lastError);
	  }

	  if (usbEvent) {
	  	if (usbEvent.resultCode !== 0) {
	      console.error("Error writing to device", usbEvent.resultCode);
	      disconnect();
	    }

	    else if (usbEvent.data) {
	      buf = new Uint8Array(usbEvent.data);
	      debug("sendKeepAliveCompleted Buffer:", usbEvent.data.byteLength, buf);

	      if (!mConnected) {
	        debug("not already connected; connecting");
	        mConnected = true;
	      }
	    }
	  }
	};

	var sendKeepAlive = function() {
		debug("sendKeepAlive()");
		chrome.usb.controlTransfer(mRiftConnectionHandle, mKeepAliveTransferInfo, sendKeepAliveCompleted);
	};

	//-----------------

	var process = function(buf) {
		debug("process()");
		var buffer = new Uint8Array(buf);
		if (mTrackerMessage.parseBuffer(buffer)) {
			debug("message successfully parsed");

			debug(mTrackerMessage.toString());

			debug("updating orientation");
			mSensorFusion.updateOrientationFromTrackerMessage(mTrackerMessage);

			var orientation = mSensorFusion.getPredictedOrientation(mPredictDt);
			debug("orientation: " + JSON.stringify(orientation));

			// NOTE: updating the DOM like this really slows things down
			//updateQuatLabel(orientation);

			sendOrientationToSimulation(orientation);

			if (mRunning) {
				pollRiftSensors();
			}
		} else {
			log("message failed parsing");
		}
	};

	var mPollSensorsTransferInfo = {
    "direction": "in",
    "endpoint" : 1,
    "length": 64
  };  // 62 is length of a single orientation block

	var pollRiftSensors = function() {
		debug("pollRiftSensors()");
		chrome.usb.bulkTransfer(mRiftConnectionHandle, mPollSensorsTransferInfo, sensorDataReceived);
	};


	var sensorDataReceived = function(usbEvent) {

	  if (chrome.runtime.lastError) {
	    console.error("sensorDataReceived Error:", chrome.runtime.lastError);
	  }

	  if (usbEvent) {
	  	if (usbEvent.resultCode !== 0) {
	      console.error("Error receiving from device; disconnecting", usbEvent.resultCode);
	      disconnect();
	    }
	    else if (usbEvent.data) {
	      process(usbEvent.data);
	    }
	  }
	};

	var debug = function(debugMessage) {
		if (mDebugEnabled) {
			console.log("rift_class (DEBUG): " + debugMessage);
		}
	}

	//-------------------

	var initRift = function() {
	  debug("initRift()");

	  if (!mRunning) {
	  	mRunning = true;

	  	// send first keep-alive to start up the connection
	  	sendKeepAlive();

	  	// start up interval task to send keep-alive message
	  	mKeepAliveIntervalId = setInterval(sendKeepAlive, KEEP_ALIVE_INTERVAL);

	  	// start receiving data from rift
	  	pollRiftSensors();
	  }
	};

	var gotPermission = function() {
		debug("App was granted the 'usbDevices' permission.");
		mHasPermission = true;

		chrome.usb.findDevices( DEVICE_INFO,
      function(devices) {
        if (!devices || !devices.length) {
          console.error('device not found');
          return;
        }
        debug('Found device: ' + devices[0].handle);
        mRiftConnectionHandle = devices[0];

        initRift();
    });
	};

	var connect = function() {
		debug("connect()");
		
		chrome.permissions.contains( mPermissionObj, function(result) {
		  if (result) {
		    gotPermission();
		  }
		});
	};

	var disconnect = function() {
		debug("disconnect()");

		if (mKeepAliveIntervalId) {
			debug("stopping keep-alive action");
			clearInterval(mKeepAliveIntervalId);	
		}
		
		mRunning = false;

		resetSensors();
		
	};

	var getPermissionObject = function() {
		return mPermissionObj;
	};

	var updateDeviceConfig = function(devicesJson) {
		if (!devicesJson || typeof devicesJson !== 'object') {
			return false;
		}
		return mSensorFusion.loadMagCalibration("default", devicesJson);
	};

	return {
		"connect": connect,
		"disconnect": disconnect,
		"getPermissionObject": getPermissionObject,
		"pollRiftSensors": pollRiftSensors,
		"updateDeviceConfig": updateDeviceConfig,
		"mPredictDt": mPredictDt
	};

};