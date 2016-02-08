"use strict";

var debug         = require('debug')('auth:signaturevalidator');
var Promise       = require('promise');
var hawk          = require('hawk');
var assert        = require('assert');
var _             = require('lodash');
require('superagent-hawk')(require('superagent'));
// Someone should rename utils to scopes... 
var utils         = require('taskcluster-lib-scopes');
var hoek          = require('hoek');
var https         = require('https');
var cryptiles     = require('cryptiles');
var crypto        = require('crypto');

/**
 * Limit the client scopes and possibly use temporary keys.
 *
 * Takes a client object on the form: `{clientId, accessToken, scopes}`,
 * applies scope restrictions, certificate validation and returns a clone if
 * modified (otherwise it returns the original).
 */
var limitClientWithExt = function(client, ext, expandScopes) {
  // Attempt to parse ext
  try {
    ext = JSON.parse(new Buffer(ext, 'base64').toString('utf-8'));
  }
  catch(err) {
    throw new Error("Failed to parse ext");
  }

  // Handle certificates
  if (ext.certificate) {
    var cert = ext.certificate;
    // Validate the certificate
    if (!(cert instanceof Object)) {
      throw new Error("ext.certificate must be a JSON object");
    }
    if (cert.version !== 1) {
      throw new Error("ext.certificate.version must be 1");
    }
    if (typeof(cert.seed) !== 'string') {
      throw new Error('ext.certificate.seed must be a string');
    }
    if (cert.seed.length !== 44) {
      throw new Error('ext.certificate.seed must be 44 characters');
    }
    if (typeof(cert.start) !== 'number') {
      throw new Error('ext.certificate.start must be a number');
    }
    if (typeof(cert.expiry) !== 'number') {
      throw new Error('ext.certificate.expiry must be a number');
    }
    if (!(cert.scopes instanceof Array)) {
      throw new Error("ext.certificate.scopes must be an array");
    }
    if (!cert.scopes.every(utils.validScope)) {
      throw new Error("ext.certificate.scopes must be an array of valid scopes");
    }

    // Check start and expiry
    var now = new Date().getTime();
    if (cert.start > now) {
      throw new Error("ext.certificate.start > now");
    }
    if (cert.expiry < now) {
      throw new Error("ext.certificate.expiry < now");
    }
    // Check max time between start and expiry
    if (cert.expiry - cert.start > 31 * 24 * 60 * 60 * 1000) {
      throw new Error("ext.certificate cannot last longer than 31 days!");
    }

    // Check scope validity

    // Validate certificate scopes are subset of client
    if (!utils.scopeMatch(client.scopes, [cert.scopes])) {
      throw new Error("ext.certificate issuer `" + client.clientId +
                      "` doesn't have sufficient scopes");
    }

    // Generate certificate signature
    var signature = crypto.createHmac('sha256', client.accessToken)
      .update([
        'version:'  + '1',
        'seed:'     + cert.seed,
        'start:'    + cert.start,
        'expiry:'   + cert.expiry,
        'scopes:',
      ].concat(cert.scopes).join('\n'))
      .digest('base64');

    // Validate signature
    if (typeof(cert.signature) !== 'string' ||
        !cryptiles.fixedTimeComparison(cert.signature, signature)) {
      throw new Error("ext.certificate.signature is not valid");
    }

    // Regenerate temporary key
    var temporaryKey = crypto.createHmac('sha256', client.accessToken)
      .update(cert.seed)
      .digest('base64')
      .replace(/\+/g, '-')  // Replace + with - (see RFC 4648, sec. 5)
      .replace(/\//g, '_')  // Replace / with _ (see RFC 4648, sec. 5)
      .replace(/=/g,  '');  // Drop '==' padding

    // Update scopes and accessToken
    client = {
      clientId:     client.clientId,
      accessToken:  temporaryKey,
      scopes:       expandScopes(cert.scopes),
    };
  }

  // Handle scope restriction with authorizedScopes
  if (ext.authorizedScopes) {
    // Validate input format
    if (!(ext.authorizedScopes instanceof Array)) {
      throw new Error("ext.authorizedScopes must be an array");
    }
    if (!ext.authorizedScopes.every(utils.validScope)) {
      throw new Error("ext.authorizedScopes must be an array of valid scopes");
    }

    // Validate authorizedScopes scopes are subset of client
    if (!utils.scopeMatch(client.scopes, [ext.authorizedScopes])) {
      throw new Error("ext.authorizedScopes oversteps your scopes");
    }

    // Update scopes on client object
    client = {
      clientId:     client.clientId,
      accessToken:  client.accessToken,
      scopes:       expandScopes(ext.authorizedScopes),
    };
  }

  // Return modified client
  return client;
};


/**
 * Make a function for the signature validation.
 *
 * options:
 * {
 *    clientLoader:   async (clientId) => {clientId, accessToken, scopes},
 *    nonceManager:   nonceManager({size: ...}),
 *    expandScopes:   (scopes) => scopes,
 * }
 *
 * The function returned takes an object:
 *     {method, resource, host, port, authorization}
 * And returns promise for an object on one of the forms:
 *     {status: 'auth-failed', message},
 *     {status: 'auth-success', scheme, scopes}, or,
 *     {status: 'auth-success', scheme, scopes, hash}
 *
 * The `expandScopes` applies any rules that expands scopes, such as roles.
 * It is assumed that clients from `clientLoader` are returned with scopes
 * fully expanded.
 *
 * The method returned by this function works as `signatureValidator` for
 * `remoteAuthentication`.
 */
var createSignatureValidator = function(options) {
  assert(typeof(options) === 'object', "options must be an object");
  assert(options.clientLoader instanceof Function,
         "options.clientLoader must be a function");
  if (!options.expandScopes) {
    // Default to the identity function
    options.expandScopes = function(scopes) { return scopes; };
  }
  assert(options.expandScopes instanceof Function,
         "options.expandScopes must be a function");
  var loadCredentials = function(clientId, ext, callback) {
    Promise.resolve(options.clientLoader(clientId)).then(function(client) {
      if (ext) {
        // We check certificates and apply limitations to authorizedScopes here,
        // if we've parsed ext incorrectly it could be a security issue, as
        // scope elevation _might_ be possible. But it's a rather unlikely
        // exploit... Besides we have plenty of obscurity to protect us here :)
        client = limitClientWithExt(client, ext, options.expandScopes);
      }
      callback(null, {
        clientToken:  client.clientId,
        key:          client.accessToken,
        algorithm:    'sha256',
        scopes:       client.scopes
      });
    }).catch(callback);
  };
  return function(req) {
    return new Promise(function(accept) {
      var authenticated = function(err, credentials, artifacts) {
        var result = null;
        if (err) {
          var message = "Unknown authorization error";
          if (err.output && err.output.payload && err.output.payload.error) {
            message = err.output.payload.error;
            if (err.output.payload.message) {
              message += ": " + err.output.payload.message;
            }
          } else if(err.message) {
            message = err.message;
          }
          result = {
            status:   'auth-failed',
            message:  '' + message
          };
        } else {
          result = {
            status:   'auth-success',
            scheme:   'hawk',
            scopes:   credentials.scopes
          };
          if (artifacts.hash) {
            result.hash = artifacts.hash;
          }
        }
        return accept(result);
      };
      if (req.authorization) {
        hawk.server.authenticate({
          method:           req.method.toUpperCase(),
          url:              req.resource,
          host:             req.host,
          port:             req.port,
          authorization:    req.authorization
        }, function(clientId, callback) {
          var ext = undefined;

          // Parse authorization header for ext
          var attrs = hawk.utils.parseAuthorizationHeader(
            req.authorization
          );
          // Extra ext
          if (!(attrs instanceof Error)) {
            ext = attrs.ext;
          }

          // Get credentials with ext
          loadCredentials(clientId, ext, callback);
        }, {
          // Not sure if JSON stringify is not deterministic by specification.
          // I suspect not, so we'll postpone this till we're sure we want to do
          // payload validation and how we want to do it.
          //payload:      JSON.stringify(req.body),

          // We found that clients often have time skew (particularly on OSX)
          // since all our services require https we hardcode the allowed skew
          // to a very high number (15 min) similar to AWS.
          timestampSkewSec: 15 * 60,

          // Provide nonce manager
          nonceFunc:    options.nonceManager
        }, authenticated);
      } else {
      // If there is no authorization header we'll attempt a login with bewit
        hawk.uri.authenticate({
          method:           req.method.toUpperCase(),
          url:              req.resource,
          host:             req.host,
          port:             req.port
        }, function(clientId, callback) {
          var ext = undefined;

          // Get bewit string (stolen from hawk)
          var parts = req.resource.match(
            /^(\/.*)([\?&])bewit\=([^&$]*)(?:&(.+))?$/
          );
          var bewitString = hoek.base64urlDecode(parts[3]);
          if (!(bewitString instanceof Error)) {
            // Split string as hawk does it
            var parts = bewitString.split('\\');
            if (parts.length === 4 && parts[3]) {
              ext = parts[3];
            }
          }

          // Get credentials with ext
          loadCredentials(clientId, ext, callback);
        }, {}, authenticated);
      }
    });
  };
};

exports.createSignatureValidator = createSignatureValidator;