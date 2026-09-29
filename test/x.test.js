const { test } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('./setup');

const { oauth1Signature, oauth1Authorization, maybeAutopostNote, notePath } = require('../server');

test('x: el enlace del post usa la URL de nota, no el ancla #note-', () => {
  // Un "#note-<id>" es un fragmento: el post llega a la portada y no a la nota,
  // y Google no lo indexa. La URL tiene que ser la misma del canonical.
  assert.equal(notePath('abc-123'), '/nota/abc-123');
  assert.ok(!notePath('abc-123').includes('#'));
});

test('x: firma OAuth 1.0a reproduce el vector canónico de RFC 5849', () => {
  const sig = oauth1Signature(
    'POST',
    'http://example.com/request',
    [
      ['b5', '=%3D'],
      ['a3', 'a'],
      ['c@', ''],
      ['a2', 'r b'],
      ['oauth_consumer_key', '9djdj82h48djs9d2'],
      ['oauth_token', 'kkk9d7dh3k39sjv7'],
      ['oauth_signature_method', 'HMAC-SHA1'],
      ['oauth_timestamp', '137131201'],
      ['oauth_nonce', '7d8f3e4a'],
      ['c2', ''],
      ['a3', '2 q']
    ],
    'j49sk3j29djd',
    'dh893hdasih9'
  );
  assert.equal(sig, 'r6/TJjbCOr97/+UU0NsvSne7s5g=');
});

test('x: oauth1Authorization construye header OAuth con firma percent-encoded', () => {
  const header = oauth1Authorization({
    method: 'POST',
    url: 'https://api.x.com/2/tweets',
    consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
    consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
    token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
    tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
    nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
    timestamp: '1318622958'
  });

  assert.ok(header.startsWith('OAuth '));
  assert.match(header, /oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog"/);
  assert.match(header, /oauth_timestamp="1318622958"/);
  assert.match(header, /oauth_signature_method="HMAC-SHA1"/);
  assert.match(header, /oauth_signature="[^"]+"/);
});

test('x: autopost deshabilitado no lanza ni publica', async () => {
  const res = await maybeAutopostNote(
    { id: 'abc', status: 'publicada', urgent: true, title: 'Urgente' },
    'https://tribuna.example'
  );
  assert.equal(res, undefined);
});