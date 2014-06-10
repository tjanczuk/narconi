Narconi - HTTP protocol for RabbitMQ
=====

Narconi is a protocol translation layer between HTTP/WebSocket and AMQP 0.9 implemented by RabbitMQ. It provides a simple HTTP and WebSocket based protocol for exchanging messages using RabbitMQ. 

With Narconi you can:

* Create and delete queues over HTTP.
* Publish and consume messages over HTTP with automatic consumption acknowledgements. 
* Subscribe to messages from a queue over WebSockets, with manual or automatic acknowledgements. 
* Publish messages to a queue over WebSockets.
* Control subscription message flow over WebSockets with configurable prefetch count. 
* Use convenient JSON encoding for message metadata.
* Specify custom message metadata. 
* Use native message format and encoding for message payload.

Currently this is a proof of concept. Some key things that are not supported include authentication/authorization, SSL, and scale out to multi-core CPUs (cluster).

## Getting started

You must have [Node.js 0.10 or greater installed](http://nodejs.org/download/). You must also have [RabbitMQ running on the system](http://www.rabbitmq.com/download.html). 

Install and run narconi:

```
sudo npm install -g narconi
narconi
```

Create a queue and publish a message:

```
curl -i -X PUT http://localhost:8080/v2/myproject/queues/myqueue
curl -i -X POST --data "Hello, world" http://localhost:8080/v2/myproject/queues/myqueue/messages 
```

Consume a message:

```
curl -i -X DELETE http://localhost:8080/v2/myproject/queues/myqueue/messages
```

## Endpoint synopsis

**PUT /v2/:project/queues/:queue**
Ensure a queue is created. 

**DELETE /v2/:project/queues/:queue**
Delete a queue with all remaining messages.

**POST /v2/:project/queues/:queue/messages**
Publish a message to a queue. 

**DELETE /v2/:project/queues/:queue/messages**
Consume a message from a queue with immediate acknowledgement.

**OPTIONS /v2/:project/queues/:queue**
Discover WebSocket endpoint to connect to for a particular queue. 

**GET /v2/:project/queues/:queue**
Establish a WebSocket connection to publish or subscribe to messages from a queue. 

## Configuration

Some aspects of narconi's behavior are controlled with environment variables:

* `PORT` specfies the TCP port number to open HTTP/WebSocket listener on. Default 8080.
* `NARCONI_AMQP_URI` specifies the [AMQP URL](http://www.rabbitmq.com/uri-spec.html) to RabbitMQ instance. Default is `amqp://guest:guest@127.0.0.1:5672/%2F`.
* `NARCONI_MAX_MESSAGE_SIZE` specifies maximum message size in bytes. Default is 64KB.
* `NARCONI_MAX_MESSAGE_TTL` is the TTL for published messages in seconds. Default is 3600 (1h).
* `NARCONI_DEFAULT_LIMIT` is the default prefetch count for WebSocket subscriptions. This can be overriden per request by the client. Default is 10. 

## HTTP/WebSocket protocol details

### Design principles

* **Embracing HTTP**. The design is optimized to favor using existing HTTP protocol features instead of inventing corresponding features on top of HTTP. For example, favor using HTTP verbs as opposed to passing *actions* in query parameters.  
* **Core messaging concepts**. The design is aligned with well known core messaging concepts and semantics of a message and queue. We don't aspire to invent or introduce novel usage patterns or ideas.  
* **Simplicity**. The design is optimized for use in a broad range of clients, including browser clients. For example, JSON is favored over XML. 
* **Performance**. The design focuses on connection-oriented WebSocket transport which maps well to the implementation of many connection-oriented messaging protocols (AMQP, MQTT, STOMP, Kafka). This enables performance optimizations related to reducing network overhead and leveraging server affinity. The HTTP endpoints provide a subset of WebSocket functionality for less demanding scenarios.

### Endpoints

The base endpoint address clients use to communicate with Narconi has the following structure:

```
https://{host}/{version}/{project}/
```

**Version** is used to support protocol versioning and is currently `v2`. 

**Project** is a unit of isolation for queues. It allows queues with the same name to exist in different projects without conflict. 

### Formats

Application messages are treated as opaque blobs. Operations that send or receive application messages send them in the HTTP request or response body in their native format. Publisher of the message can set an arbitrary *Content-Type* for the message. The content type is preserved by Narconi and propagated to the consumer. 

All Narconi operations that do not exchange application messages are using JSON format. 

### Errors

Reqeusts that are unsuccessful are using standard HTTP error status codes. They may contain additional error information in a JSON object in the response body. If present, the object will have the `message` property containing a string. The object may contain additional parameters specific to the error condition. 

### Authentication

Not implemented yet.

### Authorization

Not implemented yet.

### Queue APIs

#### Ensure a queue exists

Queues must exist before they can be used. 

```
PUT /{version}/{project}/queues/{queue_name}
```

Empty HTTP 201 response on success. 

#### Delete queue

Deleting a queue deletes all messages in it. 

```
DELETE /{version}/{project}/queues/{queue_name}
```

Empty HTTP 204 response on success. 

#### Discovery of websocket endpoint

Not implemented yet. For performance reasons, in clustered deployments it is useful to enable the client to establish a WebSocket connection to the particular instance of a backend which handles a speciifc queue. This endpoint enables the client to discover the WebSocket endpoint for a paticular queue. Given it is not yet implemented, currently Narconi clients establish WebSocket connections to the same URL as the one used to create a queue. 

To discover an endpoint client can connect to for performing operations on muliple messages, an OPTIONS request is made:

```
OPTIONS /{version}/{project}/queues/{queue_name}
```

The HTTP 200 response will contain the Websocket endpoint for the specific queue in the *Location* HTTP response header:

```
HTTP/1.1 200 OK
Location: wss://{host}/{version}/{project}/queues/{queue_name}
```

This endpoint exists because no major websocket clients support HTTP redirect of HTTP WebSocket upgrade requests, which would be a more natural way of disemminating server affinity information to the client. 

### Publish APIs

#### Publish single message

```
HTTP POST /{version}/{project}/queues/{queue_name}/messages
Content-Type: ...
x-msg-x-name1: foo
x-msg-x-name2: bar
```

The *Content-Type* header specifies the MIME type of the message being published. The HTTP request body contains the message in its native format. 

The request may contain a number of `x-msg-x-<name>` HTTP request headers. These are treated as application-specific metadata that will be preserved along with the message and sent to the consumer when the message is received. 

Empty HTTP 201 response on success.  

#### Publish multiple messages

To efficiently publish multiple messages, the caller first establishes a websocket connection to the server, and then uses that websocket connection to publish multiple messages.

```
GET /{version}/{project}/queues/{queue_name}/messages HTTP/1.1
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: ...
Sec-WebSocket-Protocol: publish
Sec-WebSocket-Version: 13
```

**NOTE** Since similar websocket connection is created to the same endpoint for the purpose of consuming multiple messages, the `Sec-WebSocket-Protocol` value of `publish` is used to indicate the specific protocol to use. 

**NOTE** Client will typically call the OPTIONS endpoint on the queue URL to discover the specific WebSocket endpoint to connect to. 

Successful handshake ends with server's HTTP 101 response. 

After the websocket connection is established, the client can start publishing muliple messages. Each message is sent to the server using up to two WebSocket messages. The first WebSocket message contains a JSON object with message metadata, conceptually corresponding to the HTTP request headers of the HTTP POST endpoint:

```json
{
    "Content-Type": "...",
    "x-msg-x-name1": "foo",
    "x-msg-x-name2": "bar",
    ...
}
```

All properties are optional. If none are specified, the client may send an empty WebSocket message instead of an empty JSON object. If *Content-Type* is omitted, it is assumed to be *application/octet-stream*. Any *x-msg-x-&lt;name&gt;* properties define application-specific message metadata and will be stored along with the message. 

The second WebSocket message contains the payload of the message to be published in its native format. 

As an optimization, if the message payload yields itself well to encoding into a JSON string, the client can use a single WebSocket message to specify both message metadata and payload. The message payload is specified as a JSON string in the `message` property, e.g.:

```json
{
    "Content-Type": "...",
    "x-msg-x-name1": "foo",
    "x-msg-x-name2": "bar",
    "message": "Hello, world!"
    ...
}
```

The server confirms reception of every message with a single, empty WebSocket message to the client. Order of confirmations is the same as the order in which the server received messages from the client. This means the client must keep track of the order of messages it sends in order to understand which are still unconfirmed. In case the websocket connection is dropped, the client must assume the unconfirmed messages were not received by the server. 

If the server cannot accept a particular message, it will send a WebSocket message with a JSON object containing information about the error to the client instead of the empty WebSocket message, e.g.:

```json
{
    "code": 400,
    "error": "TTL value too large"
}
```

The JSON object will always contain the *code* property with an HTTP status code representing the error condition. Optionally, the *error* property may provide more information about the error condition as a string. 

When the client is done sending messages and receiving confirmations, it closes the websocket connection.

### Consume APIs

#### Consume single message

This API gets a next message from the queue. The message is immediately acknowledged and permanently removed form the queue.

```
HTTP DELETE /{version}/{project}/queues/{queue_name}/messages
```

**NOTE** If the message delivery fails between the Narconi server and the client after Narconi acknowledged consumption with the backend, the message will be permanently lost. If at-least-once guarantees are requried, use the WebSocket endpoint with manual acknowledgments. 

If no message is available, the response is HTTP 204 (No Content).

If a message is available, the HTTP 200 response is returned with the message in the HTTP response body. A sample response may look like this: 

```
HTTP/1.1 200 OK
Content-Type: text/plain
x-msg-redelivered: false
x-msg-timestamp: 12216256715261
x-msg-x-name1: foo
x-msg-x-name2: bar

This is a sample message.
```

The message preserves its MIME conent type specified when it was published, and the response contains appropriate *Content-Type* header. The `x-msg-timestamp` header contains the publication timestamp of the message. The `x-msg-redelivered` header indicates whether the message was previously delivered but the consumer failed without acknowledging the message. 

If the producer specified custom application-specic metadata during message publication, that metadata is reflected in the *x-msg-x-&lt;name&gt;* HTTP response headers. 

#### Consume multiple messages

To efficiently consume multiple messages, the caller first establishes a websocket connection to the server, and then uses that websocket connection to receive messages or acknowledge them.

```
GET /{version}/{project}/queues/{queue_name}/messages[?ack,limit,encoding] HTTP/1.1
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: ...
Sec-WebSocket-Protocol: consume
Sec-WebSocket-Version: 13
```

**NOTE** Since similar websocket connection is created to the same endpoint for the purpose of publishing multiple messages, the `Sec-WebSocket-Protocol` value of `consume` is used to indicate the specific protocol to use. 

**NOTE** Client will typically call the OPTIONS endpoint on the queue URL to discover the specific WebSocket endpoint to connect to. 

The optional *ack* query parameter controls consumption acknowledgments. If present, the server will require explicit consumption acknowledgments from the client to permanently remove the message from the system. If absent, messages are implicitly acknowledged when sent from the backend to the client. Note that the implicit aknowledgement can result in message loss in case of a failure.  

The optional *limit* query parameter controls the maximum number of unacknowledged messages the client is willing to process at a time. After sending *limit* messages to the client, the server will wait for the client to acknowledge one or more of them before sending new ones. The *limit* paramater does not affect processing when the *ack* parameter is not specified. 

The optional *encoding* query parameter controls server side encoding of message payload. It allows clients in constrained environments not capable of receiving binary WebSocket messages (e.g. web browsers) to receive the message payload encoded using base64, hex, or UTF-8 encoding. 

Successful handshake ends with server's HTTP 101 response. 

After the websocket connection is established, the client can start receiving messages. Each message is sent to the client using two WebSocket messages. The first WebSocket message contains a JSON object with message metadata, conceptually corresponding to the WebSocket publishing message:

```json
{
    "Content-Type": "...",
    "timestamp": 12216256715261,
    "redelivered": false,
    "ackId": "7",
    "x-msg-x-name1": "foo",
    "x-msg-x-name2": "bar",
    ...
}
```

The *timestamp* property indicates the publication timestamp of the message. The *redelived* property indicates whether the message was previously delivered to a client that did not acknowledge it before disconnecting. The *ackId* property represents the acknowledgement ID and is present when the client specified the *ack* request query parameter when establishing the websocket connection. The value of that property is a string opaque to the client. The client can use the acknowledgement ID to permanently delete the message when it is fully processed. The *Content-Type* property represents the MIME type of the message specified during its publication. If the producer specified custom application-specic metadata during message publication, that metadata is reflected in the *x-msg-x-&lt;name&gt;* properties. 

The second WebSocket message contains the payload of the message in its native format. 

If the client specified the *encoding* query parameter, the payload of the message is sent as a *message* property of the JSON object in the first WebSocket message, and there is no second WebSocket message from Narconi.

If the client specified the *ack* parameter when creating the websocket connection, client must explicitly confirm message consumption. 

To confirm message consumption and permanently delete the message from the server, client sends a WebSocket message to the server with a JSON object:

```json
{
    "ackId": "7"
}
```

The *ackId* property contains the acknowledgement ID of a specific message to be confirmed and deleted. 

Alternatively, the client may request all messages received up to and including a specific aknowledgment ID to be removed at once using the *ackToId* property:

```json
{
    "ackToId": "7"
}
```

At any time, the server may send an error message back to the client. This is typically followd by the WebSocket connection being closed, e.g:

```json
{
    "code": 500,
    "error": "Unrecognized acknowledgment ID"
}
```

The JSON object will always contain the *code* property with an HTTP status code representing the error condition. Optionally, the *error* property may provide more information about the error condition as a string. 

When the client does not want to receive any more messages from the server, it gracefully shuts down the connection by:

1. Sending an empty WebSocket message to the server. When the server receives that message, it stops sending any new queued messages to the client. 
2. Processing all messages that were already sent by the server, and confirming them with a WebSocket message to the server as described above. 
3. Closing the websocket connection. 
