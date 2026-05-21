const express = require('express');
const { ExpressPeerServer } = require('peer');

const app = express();
const port = process.env.PORT || 9000;

app.get('/', (req, res) => {
  res.send('Divide & Conquer PeerJS broker — alive');
});

const server = app.listen(port, () => {
  console.log('Listening on', port);
});

const peerServer = ExpressPeerServer(server, {
  path: '/',
  allow_discovery: false,
  proxied: true,
});

app.use('/peerjs', peerServer);

peerServer.on('connection', (client) => console.log('+ peer', client.getId()));
peerServer.on('disconnect', (client) => console.log('- peer', client.getId()));
