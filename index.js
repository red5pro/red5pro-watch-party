/*
Copyright © 2015 Infrared5, Inc. All rights reserved.

The accompanying code comprising examples for use solely in conjunction with Red5 Pro (the "Example Code") 
is  licensed  to  you  by  Infrared5  Inc.  in  consideration  of  your  agreement  to  the  following  
license terms  and  conditions.  Access,  use,  modification,  or  redistribution  of  the  accompanying  
code  constitutes your acceptance of the following license terms and conditions.

Permission is hereby granted, free of charge, to you to use the Example Code and associated documentation 
files (collectively, the "Software") without restriction, including without limitation the rights to use, 
copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit 
persons to whom the Software is furnished to do so, subject to the following conditions:

The Software shall be used solely in conjunction with Red5 Pro. Red5 Pro is licensed under a separate end 
user  license  agreement  (the  "EULA"),  which  must  be  executed  with  Infrared5,  Inc.   
An  example  of  the EULA can be found on our website at: https://account.red5pro.com/assets/LICENSE.txt.

The above copyright notice and this license shall be included in all copies or portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,  INCLUDING  BUT  
NOT  LIMITED  TO  THE  WARRANTIES  OF  MERCHANTABILITY, FITNESS  FOR  A  PARTICULAR  PURPOSE  AND  
NONINFRINGEMENT.   IN  NO  EVENT  SHALL INFRARED5, INC. BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, 
WHETHER IN  AN  ACTION  OF  CONTRACT,  TORT  OR  OTHERWISE,  ARISING  FROM,  OUT  OF  OR  IN CONNECTION 
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/
(function(window, document, red5prosdk) {
  'use strict';

  var isPublishing = false;

  var serverSettings = (function() {
    var settings = sessionStorage.getItem('r5proServerSettings');
    try {
      return JSON.parse(settings);
    }
    catch (e) {
      console.error('Could not read server settings from sessionstorage: ' + e.message);
    }
    return {};
  })();

  var configuration = (function () {
    var conf = sessionStorage.getItem('r5proTestBed');
    try {
      return JSON.parse(conf);
    }
    catch (e) {
      console.error('Could not read testbed configuration from sessionstorage: ' + e.message);
    }
    return {}
  })();
  red5prosdk.setLogLevel(configuration.verboseLogging ? red5prosdk.LOG_LEVELS.TRACE : red5prosdk.LOG_LEVELS.WARN);

  var updateStatusFromEvent = window.red5proHandlePublisherEvent; // defined in src/template/partial/status-field-publisher.hbs

  var targetPublisher;
  var hostSocket;
  var roomName = window.query('room') || 'red5pro'; // eslint-disable-line no-unused-vars
  var streamName = window.query('streamName') || ['publisher', Math.floor(Math.random() * 0x10000).toString(16)].join('-');
  var socketEndpoint = window.query('socket') || 'localhost';
  
  var roomField = document.getElementById('room-field');
  // eslint-disable-next-line no-unused-vars
  var publisherContainer = document.getElementById('publisher-container');
  var publisherMuteControls = document.getElementById('publisher-mute-controls');
  var publisherSession = document.getElementById('publisher-session');
  var publisherNameField = document.getElementById('publisher-name-field');
  var streamNameField = document.getElementById('streamname-field');
  var publisherVideo = document.getElementById('red5pro-publisher');
  var audioCheck = document.getElementById('audio-check');
  var videoCheck = document.getElementById('video-check');
  var joinButton = document.getElementById('join-button');
  var statisticsField = document.getElementById('statistics-field');
  var bitrateField = document.getElementById('bitrate-field');
  var packetsField = document.getElementById('packets-field');
  var resolutionField = document.getElementById('resolution-field');
  var bitrateTrackingTicket;
  var bitrate = 0;
  var packetsSent = 0;
  var frameWidth = 0;
  var frameHeight = 0;

  function updateStatistics (b, p, w, h) {
    statisticsField.classList.remove('hidden');
    bitrateField.innerText = b === 0 ? 'N/A' : Math.floor(b);
    packetsField.innerText = p;
    resolutionField.innerText = (w || 0) + 'x' + (h || 0);
  }

  function onBitrateUpdate (b, p) {
    bitrate = b;
    packetsSent = p;
    updateStatistics(bitrate, packetsSent, frameWidth, frameHeight);
    if (packetsSent > 100) {
      establishSocketHost(targetPublisher, roomField.value, streamNameField.value);
    }
  }

  function onResolutionUpdate (w, h) {
    frameWidth = w;
    frameHeight = h;
    updateStatistics(bitrate, packetsSent, frameWidth, frameHeight);
  }

  roomField.value = roomName;
  streamNameField.value = streamName;
  audioCheck.checked = configuration.useAudio;
  videoCheck.checked = configuration.useVideo;

  joinButton.addEventListener('click', function () {
    saveSettings();
    doPublish(streamName);
    setPublishingUI(streamName);
  });

  audioCheck.addEventListener('change', updateMutedAudioOnPublisher);
  videoCheck.addEventListener('change', updateMutedVideoOnPublisher);

  var protocol = serverSettings.protocol;
  var isSecure = protocol == 'https';
  
  function saveSettings () {
    streamName = streamNameField.value;
    roomName = roomField.value;
  }

  function updateMutedAudioOnPublisher () {
    if (targetPublisher && isPublishing) {
      var c = targetPublisher.getPeerConnection();
      var senders = c.getSenders();
      var params = senders[0].getParameters();
      if (audioCheck.checked) { 
        if (audioTrackClone) {
          senders[0].replaceTrack(audioTrackClone);
          audioTrackClone = undefined;
        } else {
          try {
            targetPublisher.unmuteAudio();
            params.encodings[0].active = true;
            senders[0].setParameters(params);
          } catch (e) {
            // no browser support, let's use mute API.
            targetPublisher.unmuteAudio();
          }
        }
      } else { 
        try {
          targetPublisher.muteAudio();
          params.encodings[0].active = false;
          senders[0].setParameters(params);
        } catch (e) {
          // no browser support, let's use mute API.
          targetPublisher.muteAudio();
        }
      }
    }
  }

  function updateMutedVideoOnPublisher () {
    if (targetPublisher && isPublishing) {
      if (videoCheck.checked) {
        if (videoTrackClone) {
          var c = targetPublisher.getPeerConnection();
          var senders = c.getSenders();
          senders[1].replaceTrack(videoTrackClone);
          videoTrackClone = undefined;
        } else {
          targetPublisher.unmuteVideo();
        }
      } else { 
        targetPublisher.muteVideo(); 
      }
    }
    !videoCheck.checked && showVideoPoster();
    videoCheck.checked && hideVideoPoster();
  }

  var audioTrackClone;
  var videoTrackClone;
  function updateInitialMediaOnPublisher () {
    var t = setTimeout(function () {
      // If we have requested no audio and/or no video in our initial broadcast,
      // wipe the track from the connection.
      var audioTrack = targetPublisher.getMediaStream().getAudioTracks()[0];
      var videoTrack = targetPublisher.getMediaStream().getVideoTracks()[0];
      var connection = targetPublisher.getPeerConnection();
      if (!videoCheck.checked) {
        videoTrackClone = videoTrack.clone();
        connection.getSenders()[1].replaceTrack(null);
      }
      if (!audioCheck.checked) {
        audioTrackClone = audioTrack.clone();
        connection.getSenders()[0].replaceTrack(null);
      }
      clearTimeout(t);
    }, 2000); 
  }

  function showVideoPoster () {
    publisherVideo.classList.add('hidden');
  }

  function hideVideoPoster () {
    publisherVideo.classList.remove('hidden');
  }

  function getSocketLocationFromProtocol () {
    return !isSecure
      ? {protocol: 'ws', port: serverSettings.wsport}
      : {protocol: 'wss', port: serverSettings.wssport};
  }

  function onPublisherEvent (event) {
    console.log('[Red5ProPublisher] ' + event.type + '.');
    if (event.type === 'WebSocket.Message.Unhandled') {
      console.log(event);
    } else if (event.type === red5prosdk.RTCPublisherEventTypes.MEDIA_STREAM_AVAILABLE) {
      window.allowMediaStreamSwap(targetPublisher, targetPublisher.getOptions().mediaConstraints, document.getElementById('red5pro-publisher'));
    }
    updateStatusFromEvent(event);
  }
  function onPublishFail (message) {
    isPublishing = false;
    console.error('[Red5ProPublisher] Publish Error :: ' + message);
  }
  function onPublishSuccess (publisher) {
    isPublishing = true;
    window.red5propublisher = publisher;
    console.log('[Red5ProPublisher] Publish Complete.');
    //establishSharedObject(publisher, roomField.value, streamNameField.value);
    if (publisher.getType().toUpperCase() !== 'RTC') {
      establishSocketHost(publisher, roomField.value, streamNameField.value);
    }
    try {
      var pc = publisher.getPeerConnection();
      var stream = publisher.getMediaStream();
      bitrateTrackingTicket = window.trackBitrate(pc, onBitrateUpdate, null, null, true);
      statisticsField.classList.remove('hidden');
      stream.getVideoTracks().forEach(function (track) {
        var settings = track.getSettings();
        onResolutionUpdate(settings.width, settings.height);
      });
    }
    catch (e) {
    }
  }
  function onUnpublishFail (message) {
    isPublishing = false;
    console.error('[Red5ProPublisher] Unpublish Error :: ' + message);
  }
  function onUnpublishSuccess () {
    isPublishing = false;
    console.log('[Red5ProPublisher] Unpublish Complete.');
  }

  function getAuthenticationParams () {
    var auth = configuration.authentication;
    return auth && auth.enabled
      ? {
        connectionParams: {
          username: auth.username,
          password: auth.password
        }
      }
      : {};
  }

  function getUserMediaConfiguration () {
    return {
      mediaConstraints: {
        audio: configuration.useAudio ? configuration.mediaConstraints.audio : false,
        video: configuration.useVideo ? configuration.mediaConstraints.video : false
      }
    };
  }

  function setPublishingUI (streamName) {
    publisherNameField.innerText = streamName;
    roomField.setAttribute('disabled', true);
    publisherSession.classList.remove('hidden');
    publisherNameField.classList.remove('hidden');
    publisherMuteControls.classList.remove('hidden');
    Array.prototype.forEach.call(document.getElementsByClassName('remove-on-broadcast'), function (el) {
      el.classList.add('hidden');
    });
  }

  // eslint-disable-next-line no-unused-vars
  function updatePublishingUIOnStreamCount (streamCount) {
    /*if (streamCount > 0) {
      publisherContainer.classList.remove('margin-center');
    } else {
      publisherContainer.classList.add('margin-center');
    }*/
  }

  function establishSocketHost (publisher, roomName, streamName) {
    if (hostSocket) return
    var wsProtocol = isSecure ? 'wss' : 'ws'
    // var url = `${wsProtocol}://${socketEndpoint}?room=${roomName}&streamName=${streamName}`
    // hacked to support remote server while doing local development
    var url = `wss://demo-live.red5.net:8443?room=${roomName}&streamName=${streamName}`
    hostSocket = new WebSocket(url)
    hostSocket.onmessage = function (message) {
      var payload = JSON.parse(message.data)
      if (roomName === payload.room) {
        streamsList = payload.streams
        processStreams(streamsList, streamName);
      }
    }
  }

  function createMainVideo () {
    var mainVideo = new red5prosdk.RTCSubscriber();
    mainVideo.init({
      protocol: 'wss',
      port: 443,
      host: 'demo-live.red5.net',
      app: 'live',
      streamName: 'demo-stream',
      rtcConfiguration: {
        iceServers: [{urls: 'stun:stun2.l.google.com:19302'}],
        iceCandidatePoolSize: 2,
        bundlePolicy: 'max-bundle'
      }, // See https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/RTCPeerConnection#RTCConfiguration_dictionary
      mediaElementId: 'red5pro-mainVideoView',
      subscriptionId: 'demo-stream' + Math.floor(Math.random() * 0x10000).toString(16),
      videoEncoding: 'NONE',
      audioEncoding: 'NONE',
    })
    .then(function(mainVideo) {
      return mainVideo.subscribe();
    })
    .then(function(mainVideo) {
      // subscription is complete.
      // playback should begin immediately due to
      //   declaration of `autoplay` on the `video` element.
    })
    .catch(function(error) {
      // A fault occurred while trying to initialize and playback the stream.
      console.error(error)
    });
  
  }

  function determinePublisher () {

    var config = Object.assign({},
                      configuration,
                      {
                        streamMode: configuration.recordBroadcast ? 'record' : 'live'
                      },
                      getAuthenticationParams(),
                      getUserMediaConfiguration());

    var rtcConfig = Object.assign({}, config, {
                      protocol: getSocketLocationFromProtocol().protocol,
                      port: getSocketLocationFromProtocol().port,
                      bandwidth: {
                        video: 256
                      },
                      mediaConstraints: {
                        audio: true,
                        video: {
                          width: {
                            exact: 320
                          },
                          height: {
                            exact: 240
                          },
                          frameRate: {
                            exact: 15
                          }
                        }
                      },
                      streamName: streamName
                   });

    var publisher = new red5prosdk.RTCPublisher();
    return publisher.init(rtcConfig);

  }

  function doPublish (name) {
    targetPublisher.publish(name)
      .then(function () {
        onPublishSuccess(targetPublisher);
        updateInitialMediaOnPublisher();
      })
      .catch(function (error) {
        var jsonError = typeof error === 'string' ? error : JSON.stringify(error, null, 2);
        console.error('[Red5ProPublisher] :: Error in publishing - ' + jsonError);
        console.error(error);
        onPublishFail(jsonError);
       });
  }

  function unpublish () {
    if (hostSocket !== undefined)  {
      hostSocket.close()
    }
    return new Promise(function (resolve, reject) {
      var publisher = targetPublisher;
      publisher.unpublish()
        .then(function () {
          onUnpublishSuccess();
          resolve();
        })
        .catch(function (error) {
          var jsonError = typeof error === 'string' ? error : JSON.stringify(error, 2, null);
          onUnpublishFail('Unmount Error ' + jsonError);
          reject(error);
        });
    });
  }

  // Kick off.
  determinePublisher()
    .then(function (publisherImpl) {
      targetPublisher = publisherImpl;
      targetPublisher.on('*', onPublisherEvent);
      createMainVideo();
      return targetPublisher.preview();
    })
    .catch(function (error) {
      var jsonError = typeof error === 'string' ? error : JSON.stringify(error, null, 2);
      console.error('[Red5ProPublisher] :: Error in publishing - ' + jsonError);
      console.error(error);
      onPublishFail(jsonError);
     });

  var shuttingDown = false;
  function shutdown () {
    if (shuttingDown) return;
    shuttingDown = true;
    function clearRefs () {
      if (targetPublisher) {
        targetPublisher.off('*', onPublisherEvent);
      }
      targetPublisher = undefined;
    }
    unpublish().then(clearRefs).catch(clearRefs);
    window.untrackBitrate(bitrateTrackingTicket);
  }
  window.addEventListener('beforeunload', shutdown);
  window.addEventListener('pagehide', shutdown);

  var streamsList = [];
  var subscribersEl = document.getElementById('subscribers');
  function processStreams (streamlist, exclusion) {
    var nonPublishers = streamlist.filter(function (name) {
      return name !== exclusion;
    });
    var list = nonPublishers.filter(function (name, index, self) {
      return (index == self.indexOf(name)) &&
        !document.getElementById(window.getConferenceSubscriberElementId(name));
    });
    var subscribers = list.map(function (name, index) {
      return new window.ConferenceSubscriberItem(name, subscribersEl, index);
    });
    var i, length = subscribers.length - 1;
    var sub;
    for(i = 0; i < 8; i++) { //used to be i<length
      sub = subscribers[i];
      sub.next = subscribers[sub.index+1];
    }
    if (subscribers.length > 0) {
      var baseSubscriberConfig = Object.assign({},
                                  configuration,
                                  {
                                    protocol: getSocketLocationFromProtocol().protocol,
                                    port: getSocketLocationFromProtocol().port
                                  },
                                  getAuthenticationParams(),
                                  getUserMediaConfiguration());
      subscribers[0].execute(baseSubscriberConfig);
    }

    updatePublishingUIOnStreamCount(nonPublishers.length);

  }

})(this, document, window.red5prosdk);

