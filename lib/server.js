#!/usr/bin/env node 

var http = require('http')
    , restify = require('restify')
    , apis = require('./apis');

var maxSize = +process.env.NARCONI_MAX_MESSAGE_SIZE || (64 * 1024);

// setup http server

var server = restify.createServer({ name: 'narconi', handleUpgrades: true });
server.use(restify.queryParser());
server.use(apis.validate);
server.use(apis.ensure_amqp_connection);
server.use(apis.ensure_channel);

server.put   ('/v2/:project/queues/:queue_name', 
    apis.create_queue);
server.del   ('/v2/:project/queues/:queue_name', 
    apis.delete_queue);
server.post  ('/v2/:project/queues/:queue_name/messages', 
    apis.buffer_body(maxSize),
    apis.ensure_queue, 
    apis.publish_message);
server.del   ('/v2/:project/queues/:queue_name/messages', 
    apis.ensure_queue, 
    apis.delete_message);
server.get   ('/v2/:project/queues/:queue_name/messages', 
    apis.ensure_queue,
    apis.handle_upgrade(maxSize));

// run server

server.listen(process.env.PORT || 8080, function () {
  console.log('%s listening at %s', server.name, server.url);
});