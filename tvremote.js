'use strict';

// This global var must be injected by the background page when creating this
// window. It will be read by the functions here, but will not be modified.
// See background.js for details.
//
// var TV_OPTS = {};


// Global vars with the current state.
var SOCKET_ID = null;
var SELF_IP = null;
var STATUS = {
	'connection_successful': null,  // null, true, false.
	'access_granted': null,  // null, true, false.
	'error': null  // null, String
};
var RECV_CALLBACK = null;
var IS_ALREADY_HANDLING_CLICK = false;

// error is the error message string.
function STATUS_reset(error) {
	STATUS.connection_successful = null;
	STATUS.access_granted = null;
	STATUS.error = null;
	if (error) {
		STATUS.error = error;
	}
	if (RECV_CALLBACK) {
		RECV_CALLBACK();
	}
}


//////////////////////////////////////////////////////////////////////
// Network-related functions, thin wrappers around Chrome API.

// Creates a new socket and connects to it.
// Chrome requires two API calls, which are encapsulated in here.
function easy_connect(ip, port, success_callback, failure_callback) {
	chrome.sockets.tcp.create({
		// bufferSize should be a power of two.
		// Given the extremely simple protocol implemented here, we can use a
		// very small buffer size.
		'bufferSize': 256
	}, function(createInfo) {
		chrome.sockets.tcp.connect(createInfo.socketId,
 		   ip, port, function(result) {
			   if (result < 0 || chrome.runtime.lastError) {
				   if (failure_callback) failure_callback(createInfo, result, chrome.runtime.lastError.message);
			   } else {
				   if (success_callback) success_callback(createInfo, result);
			   }
		   });
	});
}


// Chrome API requires an ArrayBuffer. This wrapper function is more lenient
// and accepts either an ArrayBuffer or a TypedArray (such as Uint8Array).
function easy_send(socketId, data, success_callback, failure_callback) {
	if (data.buffer) {  // If data is a TypedArray or DataView.
		data = data.buffer;  // Get the ArrayBuffer behind it.
	}
	chrome.sockets.tcp.send(socketId, data, function(sendInfo) {
		if (sendInfo.resultCode < 0 || chrome.runtime.lastError) {
			if (failure_callback) failure_callback(sendInfo.resultCode, chrome.runtime.lastError.message);
		} else if (sendInfo.resultCode == 0 && sendInfo.bytesSent != data.byteLength) {
			if (failure_callback) failure_callback(sendInfo.resultCode, 'Sent only ' + sendInfo.bytesSent + ' of ' + data.length + ' bytes.');
		} else {
			if (success_callback) success_callback();
		}
	});
}


//////////////////////////////////////////////////////////////////////
// Convenience functions, just to make the code easier to write without
// worrying about details.
//
// For convenience, only a single socket is kept open.

// Disconnects the current socket.
// Does nothing it there is no active socket.
// Disconnecting DOES NOT change STATUS. It is by design, to let the user see
// the last known status.
function disconnect(callback) {
	if (SOCKET_ID !== null) {
		// console.log('Disconnecting SOCKET_ID = ' + SOCKET_ID);
		chrome.sockets.tcp.close(SOCKET_ID, function() {
			// console.log('Disconnected.');
			SOCKET_ID = null;
			if (callback) callback();
		});
	} else {
		if (callback) callback();
	}
}


// Connects the socket.
// Automatically disconnects any previous socket.
function connect(callback, failure_callback) {
	disconnect(function() {
		// console.log('Starting up connection to ', TV_OPTS.tv_ip, TV_OPTS.tv_port);
		easy_connect(TV_OPTS.tv_ip, TV_OPTS.tv_port, function(socketInfo, result) {
			SOCKET_ID = socketInfo.socketId;
			SELF_IP = socketInfo.localAddress;
			STATUS.error = null;
			// console.log('Connected. SOCKET_ID = ' + SOCKET_ID + ', SELF_IP = ' + SELF_IP);
			if (callback) callback();
		}, function(socketInfo, result, message) {
			console.error('Connection error: ', result, message);
			STATUS_reset('Connection error: ' + message);
			if (failure_callback) failure_callback();
		});
	});
}


// Sends a packet.
function send(data, callback, failure_callback) {
	if (SOCKET_ID === null) {
		//throw 'Programming error! Socket is not connected!';
		// console.log('Not sending because there is no socket.');
		if (failure_callback) failure_callback();
		return;
	}
	// console.log('Sending a packet.');
	easy_send(SOCKET_ID, data, function() {
		// console.log('Sent a packet.');
		STATUS.error = null;
		if (callback) callback();
	}, function(result, message) {
		console.error('Send error: ', result, message);
		STATUS_reset('Send error: ' + message);
		if (failure_callback) failure_callback();
	});
}


// Receives a packet.
function on_receive_handler(info) {
	if (info.socketId != SOCKET_ID) {
		return;
	}

	var response = unpack_auth_response(info.data);
	var auth_response = understand_auth_response(response);
	// console.log('Received: ', info.socketId, response.header, response.magic_string, response.payload, auth_response);

	if (response.header >= 0 && response.header <= 2) {
		STATUS.connection_successful = true;
	} else {
		STATUS.connection_successful = false;
	}

	if (auth_response == AuthResponse.GRANTED) {
		STATUS.access_granted = true;
	} else if (auth_response == AuthResponse.DENIED) {
		STATUS.access_granted = false;
	}

	if (RECV_CALLBACK) {
		RECV_CALLBACK();
	}

	if (auth_response == AuthResponse.DENIED) {
		//disconnect();
	}
}

function on_receive_error_handler(info) {
	if (info.socketId != SOCKET_ID) {
		return;
	}

	if (info.resultCode == -100) {
		// NET_CONNECTION_CLOSED, which is not an error.
		disconnect();
		return;
	}

	console.error('Error received: ', info.resultCode);
	STATUS_reset('Error received: ' + info.resultCode);
	disconnect();
}


//////////////////////////////////////////////////////////////////////
// High-level send-key functions.

function send_key(key_code, callback, failure_callback) {
	connect(function() {
		var auth_data = build_auth_packet(SELF_IP, TV_OPTS.unique_id, TV_OPTS.display_name);
		send(auth_data, function() {
			var key_packet = build_key_packet(key_code);
			send(key_packet, callback, failure_callback);
		}, failure_callback);
	}, failure_callback);
}


function send_multiple_keys_single_connection(keys, callback) {
	// Making a copy of the array, so that this function can make changes to
	// the copied array without changing the original one.
	var keys = keys.slice();

	var failure_callback = callback;

	function _send_multiple_keys_recursive() {
		if (keys.length < 1) {
			if (callback) callback();
			return;
		}

		var key = keys.shift();
		var key_packet = build_key_packet(key);
		send(key_packet, _send_multiple_keys_recursive, failure_callback);
	}

	connect(function() {
		var auth_data = build_auth_packet(SELF_IP, TV_OPTS.unique_id, TV_OPTS.display_name);
		send(auth_data, _send_multiple_keys_recursive, failure_callback);
	}, failure_callback);
}

function send_multiple_keys_multiple_connections(keys, callback) {
	// Making a copy of the array, so that this function can make changes to
	// the copied array without changing the original one.
	var keys = keys.slice();

	var failure_callback = callback;

	function _send_multiple_keys_recursive() {
		if (keys.length < 1) {
			if (callback) callback();
			return;
		}

		var key = keys.shift();
		send_key(key, function() {
			setTimeout(_send_multiple_keys_recursive, 50);
		}, failure_callback);
	}
	_send_multiple_keys_recursive();
}

//////////////////////////////////////////////////////////////////////
// Layout stuff.

function create_button_grid_from_layout(layout) {
	var section = document.createElement('section');
	section.classList.add('tvremote', 'grid');

	if (layout.fontSize) {
		section.style.fontSize = layout.fontSize;
	}

	var i, j, cell;
	var divrow, span, button;
	for (i = 0; i < layout.rows.length; i++) {
		divrow = document.createElement('div');
		divrow.classList.add('row');
		section.appendChild(divrow);

		for (j = 0; j < layout.rows[i].cells.length; j++) {
			cell = layout.rows[i].cells[j];

			if (cell.label === null) {
				span = document.createElement('span');
				span.classList.add('cell', 'empty');
				divrow.appendChild(span);
				continue;
			}

			button = document.createElement('button');
			button.appendChild(document.createTextNode(cell.label));
			button.dataset.key = cell.key;
			button.classList.add('cell', 'tvremotebutton');
			divrow.appendChild(button);

			if (cell.css) {
				button.className += ' ' + cell.css;
			}
		}
	}

	return section;
}

function create_svg_file_layout(layout) {
	var section = document.createElement('section');
	section.classList.add('tvremote', 'svgfile');

	// It is necessary to insert the SVG code inline, otherwise it won't be
	// possible to handle click events (at least not in a straight-forward
	// way).
	var request = new XMLHttpRequest();
	request.onload = function() {
		var raw = this.responseText;
		raw = raw.replace(/^\s*<!DOCTYPE[^>]*>/i, '');
		section.innerHTML = raw;
	};
	request.open('GET', layout.file, true);
	request.overrideMimeType('text/plain; charset=utf8');
	request.send();

	return section;
}

function build_layout(layout) {
	var layout_container = document.getElementById('layout_container');

	// Constructing the buttons.
	layout_container.innerHTML = '';

	if (layout.layout == 'grid') {
		layout_container.appendChild(create_button_grid_from_layout(layout));
	} else if (layout.layout == 'svgfile') {
		layout_container.appendChild(create_svg_file_layout(layout));
	} else {
		alert('Invalid value: "layout": "' + layout.layout + '"');
	}
}


//////////////////////////////////////////////////////////////////////

function tvremote_key_click_handler(ev) {
	if (IS_ALREADY_HANDLING_CLICK) {
		// Ideally, the clicks would be queued. But the easiest solution is to
		// just ignore them.
		return;
	}

	var key = ev.target.dataset.key;
	if (key) {
		ev.preventDefault();
		ev.stopPropagation();

		IS_ALREADY_HANDLING_CLICK = true;

		// Splitting the comma-separated list. Also trimming the whitespace.
		var keys = key.split(',');
		var i;
		for (i = 0; i < keys.length; i++) {
			keys[i] = keys[i].trim();
		}

		if (TV_OPTS.macro_behavior === 'multiple_connections') {
			send_multiple_keys_multiple_connections(keys, function() {
				IS_ALREADY_HANDLING_CLICK = false;
			});
		} else if (TV_OPTS.macro_behavior === 'single_connection') {
			send_multiple_keys_single_connection(keys, function() {
				IS_ALREADY_HANDLING_CLICK = false;
			});
		} else {
			STATUS.error = '(Internal error) Unknown macro_behavior value: ' + TV_OPTS.macro_behavior;
			console.error(STATUS.error);
			update_status_ui();
		}
	}
}

function close_window() {
	window.close();
}

function open_options() {
	document.getElementById('options_button').blur();
	chrome.runtime.getBackgroundPage(function(background) {
		background.open_options_window();
	});
}

// Inserts a ZWSP character in sensible places, to make the text look better
// when broken.
// https://en.wikipedia.org/wiki/Zero-width_space
function insert_ZWSP(s) {
	return s.replace(/(:+)/g, '$1\u200B').replace(/(_+|\.+)/g, '\u200B$1');
}


function update_status_ui() {
	var status_container = document.getElementById('status_container');
	var status_label = document.getElementById('status_label');
	// var status_icon = document.getElementById('status_icon');

	status_container.classList.remove('gray', 'yellow', 'green', 'red');
	if (STATUS.error) {
		status_container.classList.add('red');
		status_label.value = insert_ZWSP(STATUS.error);
	} else if (STATUS.connection_successful === true) {
		if (STATUS.access_granted === true) {
			status_container.classList.add('green');
			status_label.value = 'Working correctly.';
		} else if (STATUS.access_granted === false) {
			status_container.classList.add('red');
			status_label.value = 'TV remote control access was DENIED.';
		} else {
			status_container.classList.add('yellow');
			status_label.value = 'Connection to the TV is working.';
		}
	} else if (STATUS.connection_successful === false) {
		status_container.classList.add('red');
		status_label.value = 'Connection failed.';
	} else {
		status_container.classList.add('gray');
		status_label.value = 'Not connected.';
	}
}

//////////////////////////////////////////////////////////////////////
// Initialization.

function set_class_dont_highlight_focused() {
	if (TV_OPTS.highlight_focused) {
		document.body.classList.remove('dont_highlight_focused');
	} else {
		document.body.classList.add('dont_highlight_focused');
	}
}

function init(tab_id, bgpage) {
	// Single click handler for all TV remote buttons.
	var layout_container = document.getElementById('layout_container');
	layout_container.addEventListener('click', tvremote_key_click_handler);

	set_class_dont_highlight_focused();

	build_layout(LAYOUT);

	// Status indicator.
	RECV_CALLBACK = update_status_ui;
	update_status_ui();

	// Close button.
	var close_button = document.getElementById('close_button');
	close_button.addEventListener('click', close_window);

	// Options button.
	var options_button = document.getElementById('options_button');
	options_button.addEventListener('click', open_options);

	// Handling TCP responses using the convoluted Chrome API.
	chrome.sockets.tcp.onReceive.addListener(on_receive_handler);
	chrome.sockets.tcp.onReceiveError.addListener(on_receive_error_handler);
}

// This script is being included with the "defer" attribute, which means it
// will only be executed after the document has been parsed.
init();
