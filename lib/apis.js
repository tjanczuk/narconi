var amqp = require('amqplib/callback_api')
	, restify = require('restify')
	, _ws = new require('ws');

var amqp_uri = process.env.NARCONI_AMQP_URI || 'amqp://guest:guest@127.0.0.1:5672/%2F';
var connections = {}; // map uf user ID to AMQP connection
var requests_pending = {}; // map uf user ID to HTTP requests awaiting AMQP connection
var queue_name_regex = /^[a-zA-Z0-9\.\-\:\_]+$/;
var project_name_regex = /^[a-zA-Z0-9]+$/;
var max_ttl = +process.env.NARCONI_MAX_MESSAGE_TTL || 3600; // 1h max
var wss = new _ws.Server({ noServer: true });
var default_limit = +process.env.NARCONI_DEFAULT_LIMIT || 10;

exports.validate = function (req, res, next) {
	if (req.params.project && !req.params.project.match(project_name_regex))
		res.send(new restify.InvalidArgumentError('Invalid project ID.'));
	else if (req.params.queue_name && !req.params.queue_name.match(queue_name_regex))
		res.send(new restify.InvalidArgumentError('Invalid queue name.'));
	else if (req.params.ttl !== undefined && (isNaN(req.params.ttl) || +req.params.ttl < 0 || +req.params.ttl > max_ttl))
		res.send(new restify.InvalidArgumentError('TTL must be in seconds and between 0 and ' + max_ttl));
	else if (req.params.limit !== undefined && (isNaN(req.params.limit) || +req.params.limit < 1))
		res.send(new restify.InvalidArgumentError('Limit must be greater than 0.'));
	else {
		req.params.scope = req.params.project + '_' + req.params.queue_name;
		next();
	}
};

exports.buffer_body = function (maxSize) {
	return function (req, res, next) {
		var chunks = [];
		var size = 0;
		req.on('data', function (b) {
			if (maxSize && size < maxSize) {
				chunks.push(b);
				size += b.length;
			}
		});
		req.on('end', function () {
			if (maxSize && size > maxSize) 
				res.send(new restify.RequestThrottledError('Message too large.'))
			else {
				req.body = Buffer.concat(chunks);
				next();
			}
		})
	};
};

exports.ensure_amqp_connection = function (req, res, next) {
	var id = 'guest'; // TODO: authenticated user ID
	if (connections[id]) {
		req.params.connection = connections[id];
		return next();
	}
	else if (requests_pending[id])
		requests_pending[id].push({ next: next, req: req, res: res });
	else {
		requests_pending[id] = [ { next: next, req: req, res: res } ];
		amqp.connect(amqp_uri, function (err, result) {
			if (err) 
				requests_pending[id].forEach(function (entry) {
					entry.res.send(new restify.InternalError('Cannot connect to the AMQP backend.'));
				});
			else {
				connections[id] = result;
				connections[id]._userId = id;
				connections[id].on('error', function () {
					delete connections[id];
				});
				connections[id].on('close', function () {
					delete connections[id];
				});
				requests_pending[id].forEach(function (entry) {
					entry.req.params.connection = result;
					entry.next();
				});
			}

			delete requests_pending[id];
		});
	}
};

exports.ensure_channel = function (req, res, next) {
	req.params.connection.createConfirmChannel(function (err, channel) {
		req.params.channel = channel;
		err ? res.send(new restify.InternalError('Unable to create AMQP channel.'))
			: next();
	});

	res.on('finish', function () {
		req.params.channel && req.params.channel.close();
		req.params.channel = undefined;
	});
};

exports.ensure_queue = function (req, res, next) {
	req.params.channel.checkQueue(req.params.scope, function (err) {
		err ? res.send(new restify.ResourceNotFoundError('Queue does not exist: ' + req.params.scope))
			: next();
	});
};

exports.create_queue = function (req, res) {
	req.params.channel.assertQueue(req.params.scope, null, function (err) {
		err ? res.send(new restify.InternalError('Unable to create queue: ' + req.params.scope)) 
			: res.send(201);
	});
};

exports.delete_queue = function (req, res) {
	req.params.channel.deleteQueue(req.params.scope, null, function (err) {
		if (err) {
			req.params.channel = undefined;
			res.send(new restify.ResourceNotFoundError(err.message));
		}
		else 
			res.send(204);
	});
};

exports.publish_message = function (req, res) {
	var options = { 
		persistent: true, 
		timestamp: Date.now(), 
		expires: 1000 * (+req.params.ttl || max_ttl)
	};

	if (req.header('Content-Type'))
		options.contentType = req.header('Content-Type');

	for (var h in req.headers)
		if (h.match(/^x\-msg\-x\-/))
			(options.headers || (options.headers = {}))[h] = req.headers[h];

	req.params.channel.publish('', req.params.scope, req.body, options, function (err) {
		err ? res.send(new restify.InternalError(err.message))
			: res.send(201);
	});
};

exports.delete_message = function (req, res) {
	req.params.channel.prefetch(1);
	req.params.channel.get(req.params.scope, { noAck: true }, function (err, msg) {
		if (err)
			return res.send(new restify.InternalError(err.message));
		if (!msg)
			return res.send(204);

		if (msg.properties.timestamp)
			res.header('x-msg-timestamp', msg.properties.timestamp);
		if (msg.fields.redelivered !== undefined)
			res.header('x-msg-redelivered', msg.fields.redelivered);
		for (var h in msg.properties.headers)
			res.header(h, msg.properties.headers[h]);
		res.header('Content-Type', msg.properties.contentType || 'application/octet-stream');
		res.end(msg.content);
	});
};

exports.handle_upgrade = function (maxSize) {
	return function (req, res, next) {
		if (!res.claimUpgrade)
			return res.send(new restify.InvalidHeaderError('Upgrade: WebSocket header expected.'));
		if (req.header('sec-websocket-protocol') !== 'publish' && req.header('sec-websocket-protocol') !== 'consume')
			return res.send(new restify.InvalidHeaderError('Sec-Websocket-Protocol must be set to `publish` or `consume`.'));

		var upgrade = res.claimUpgrade();
		wss.handleUpgrade(req, upgrade.socket, upgrade.head, function (ws) {
			req.params.ws = ws;
			req.params.maxSize = maxSize;
			if (req.header('sec-websocket-protocol') === 'publish')
				websocket_publish(req.params);
			else
				websocket_consume(req.params);
		});
	}
};

function websocket_publish(params) {
	var shutdown = create_shutdown(params);
	var packet;

	params.ws.on('message', function (data, flags) {
		if (!params.ws)
			return;

		if (data && data.length > params.maxSize)
			return shutdown(new restify.RequestThrottledError('Message too large.'));

		if (packet) 
			packet.message = data;
		else if (flags.binary) 
			packet = { message: data };
		else {
			try {
				packet = JSON.parse(data);
			}
			catch (e) {
				shutdown(new restify.InvalidContentError('Payload must be binary or a JSON object.'));
			}			
		}

		if (packet && packet.message !== undefined) 
			publish();
	});

	params.ws.on('close', function () {
		shutdown();
	});

	params.channel.on('close', function () {
		shutdown(new restify.InternalError('AMQP channel was closed.'));
	});

	params.connection.on('close', function () {
		shutdown(new restify.InternalError('AMQP connection was unexpectedly closed.'));
	});

	function publish() {
		var options = { 
			persistent: true, 
			timestamp: Date.now(), 
			expires: 1000 * (+packet.ttl || max_ttl)
		};

		if (packet['Content-Type'])
			options.contentType = packet['Content-Type'];

		for (var h in packet)
			if (h.match(/^x-/))
				(options.headers || (options.headers = {}))[h] = packet[h];

		if (!Buffer.isBuffer(packet.message))
			packet.message = packet.message ? new Buffer(packet.message) : new Buffer();

		params.channel.publish('', params.scope, packet.message, options, function (err) {
			try {
				err ? shutdown(new restify.InternalError('Unable to publish message.'))
					: (params.ws && params.ws.send());
			}
			catch (e) {
				shutdown(new restify.InternalError('Unable to send confirmation to the client.'));
			}
		});

		packet = undefined;
	}
}

function websocket_consume(params) {
	var shutdown = create_shutdown(params);
	var consumerTag;
	params.channel.on('error', function (err) {
		shutdown(new restify.InternalError('AMQP channel unexpectedly closed. Details: ' + err.message));
	});
	params.channel.prefetch(+params.limit || default_limit);
	params.channel.consume(
		params.scope, onMessage, { noAck: params.lock === undefined }, function (err, ok) {
			if (err)
				return shutdown(new restify.InternalError('AMQP channel unexpectedly closed.'));
			consumerTag = ok.consumerTag;
		});

	params.ws.on('message', function (data, flags) {
		if (!params.ws)
			return;

		if (!data || data.length === 0) {
			try {
				return params.channel.cancel(consumerTag);
			}
			catch (e) {
				return shutdown(new restify.InternalError('Unable to cancel message delivery.'));
			}
		}

		var payload;
		try {
			if (flags.binary) throw new Error();
			payload = JSON.parse(data);
			if (typeof payload !== 'object') throw new Error();
		}
		catch (e) {
			return shutdown(new restify.InvalidContentError('Payload must be a JSON object.'));
		}

		if (typeof payload['ackId'] === 'string' || typeof payload['ackToId'] === 'string') {
			if (params.lock === undefined)
				return shutdown(new restify.InvalidContentError('Acks can only be sent on connections without immediate acks.'))
			try {
				params.channel.ack(
					{ fields: { deliveryTag: +payload['ackId'] || +payload['ackToId'] }}, 
					!isNaN(payload['ackToId']));
			}
			catch (e) {
				shutdown(new restify.InternalError('Unable to ack a message.'));		
			}
		}
		else 
			shutdown(new restify.InvalidContentError('Unrecognized command.'));			
	});

	params.ws.on('close', function () {
		shutdown();
	});

	params.connection.on('close', function () {
		shutdown(new restify.InternalError('AMQP connection was unexpectedly closed.'));
	});	

	function onMessage(msg) {
		if (!params.ws)
			return;

		try {
			var payload = {};
			payload['Content-Type'] = msg.properties.contentType || 'application/octet-stream';
			if (msg.properties.timestamp)
				payload['timestamp'] = msg.properties.timestamp;
			if (msg.fields.redelivered !== undefined)
				payload['redelivered'] = msg.fields.redelivered;
			if (msg.fields.deliveryTag !== undefined && params.lock !== undefined)
				payload['ackId'] = '' + msg.fields.deliveryTag;
			for (var h in msg.properties.headers)
				payload[h] = msg.properties.headers[h];
			if (typeof params.encoding === 'string') {
				payload.message = msg.content.toString(params.encoding);
				params.ws.send(JSON.stringify(payload));
			}
			else {
				params.ws.send(JSON.stringify(payload));
				params.ws.send(msg.content);				
			}

		}
		catch (e) {
			shutdown(new restify.InternalError('Unable to send message to client.'));
		}
	}
}

function create_shutdown(params) {
	return function (error) {
		if (!params.ws)
			return;

		if (error) {
			try {
				params.ws.send(JSON.stringify({ 
					error: error.message, 
					code: error.statusCode 
				}));
			}
			catch (e) {}
		}

		try {
			params.ws.close();
		}
		catch (e) {}

		params.ws = null;

		try {
			params.channel.close();
		}
		catch (e) {}
	};	
}