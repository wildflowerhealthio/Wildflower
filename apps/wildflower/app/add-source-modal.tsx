import { Schema } from '@livestore/livestore'
import { Array, DateTime, Either } from 'effect'
import { Link } from 'expo-router'
import { Code } from 'fhir-r4-livestore/data-types'
import { Patient, Bundle } from 'fhir-r4-livestore/resources'
import { events } from 'fhir-r4-livestore/schema'

import React, { JSX } from 'react'
import { StyleSheet } from 'react-native'
import { WebView } from 'react-native-webview'
import { useAppStore } from '@/livestore/store'
import { ThemedText } from '../components/themed-text'
import { ThemedView } from '../components/themed-view'

export default function AddSourceModalScreen(): JSX.Element {
  const webref = React.useRef<WebView>(null)
  const { commit } = useAppStore()
  const handleMessage = (event: any): void => {
    if (event.body && typeof event.mimeType === 'string' && typeof event.url === 'string') {
      const either = Schema.decodeUnknownEither(Bundle.Schema(Patient))(event.body)
      Either.match(either, {
        onLeft: (err) => {
          console.warn('Failed to decode Patient from WebView message', {
            error: err,
            body: event.body,
          })
        },
        onRight: (bundle) => {
          if (
            bundle.entry &&
            Array.isNonEmptyArray(bundle.entry) &&
            bundle.entry[0].resource?.resourceType === 'Patient'
          ) {
            console.log('Decoded Patient Bundle from WebView message', { bundle })
            commit(
              events.patientReceived({
                patient: bundle.entry[0].resource,
                source: event.url,
                mimeType: Code.make(event.mimeType),
                addedAt: DateTime.unsafeNow(),
                sourceData: JSON.stringify(event.body, null, 2),
              })
            )
          } else {
            {
              console.warn('Decoded Bundle did not contain a Patient resource as expected', {
                bundle,
              })
              return
            }
          }
        },
      })
    } else {
      console.log('Received message from WebView', { event })
    }
  }
  return (
    <ThemedView style={styles.container}>
      <ThemedText type="title">Add a source</ThemedText>
      <WebView
        ref={webref}
        containerStyle={styles.webview}
        source={{
          uri: 'https://launch.smarthealthit.org/sample-app?aud=https%3A%2F%2Flaunch.smarthealthit.org%2Fv%2Fr4%2Fsim%2FWzMsImQ0ZmIzYmJhLTczYTktNGI4Mi1hMGJjLTY3OGQ0N2YzODZiNCIsIjFjYjUxMTU3LTgwODMtNDEwZi04N2QxLTA3YTk0NjI5MjIyYSIsIkFVVE8iLDAsMCwwLCIiLCIiLCIiLCIiLCIiLCIiLCIiLDAsMSwiIl0%2Ffhir',
        }}
        onMessage={(event) => {
          const msg = JSON.parse(event.nativeEvent.data)
          console.log(`From WebView onMessage`, JSON.stringify(msg, null, 2))
          handleMessage(msg)
        }}
        injectedJavaScriptBeforeContentLoaded={sniffRequests}
        onLoadProgress={(_event) => {
          webref.current?.injectJavaScript(sniffRequests)
        }}
      ></WebView>
      <Link href="/" dismissTo style={styles.link}>
        <ThemedText type="link">Go to home screen</ThemedText>
      </Link>
    </ThemedView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  webview: {
    width: '100%',
    height: 0,
    flex: 1,
    margin: 0,
  },
  link: {
    marginTop: 15,
    paddingVertical: 15,
  },
})

const sniffRequests = `
  if (!window.nativeFetch) {
    window.ReactNativeWebView?.postMessage(JSON.stringify({ log: 'Shimming fetch' }));  
    window.nativeFetch = window.fetch;

    window.customFetch = async function(request, headers) {

      var req;
      var response;

      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'fetching', request, headers }));
      let url;
      if (typeof request == 'string') {
        url = request;
        req = new Request(request, headers);
        response = await window.nativeFetch(req);
        response.requestInputObject = req;
      } else {
        url = request.url;
        response = await window.nativeFetch(request, headers);
      }
      const rClone = response.clone(); 
      const text = await rClone.text();
      let body = ''
      try {
        body = JSON.parse(text)
      } catch (e) {
        body = text
      }
      window.ReactNativeWebView.postMessage(JSON.stringify({ 
        type: 'fetched', 
        url,
        mimeType: response.headers.get('Content-Type') || '',
        headers: rClone.headers, 
        statusText: rClone.statusText, 
        body, 
      }));

      if (typeof request == 'object') {

        response.requestInputObject = request;

      } else {

        response.requestInputURL = request;
        response.requestInputObject = req;

      }

      if (headers) { response.requestInputHeaders = headers; }

      return response;

    }
    window.fetch = window.customFetch;
  }
  if (!window.oldXHROpen) {
    window.ReactNativeWebView?.postMessage(JSON.stringify({ log: 'Shimming XMLHttpRequest.open' }));
    window.oldXHROpen = window.XMLHttpRequest.prototype.open;
      window.XMLHttpRequest.prototype.open = function(method, url, isAsync, user, password) {
      // do something with the method, url and etc.
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'xhrOpening', method, url, isAsync, user, password }));

      this.addEventListener('load', function() {
        let body = ''
        try {
          body = JSON.parse(this.responseText)
        } catch (e) {
          body = this.responseText
        }

        window.ReactNativeWebView.postMessage(JSON.stringify({ 
          type: 'xhrOpened',
          url: this.responseURL,
          mimeType: this.getResponseHeader('Content-Type') || '',
          body 
        }));
      });
                    
      return window.oldXHROpen.apply(this, arguments);
    }
  } 
  if (!window.oldXHRSend) {
    window.oldXHRSend = window.XMLHttpRequest.prototype.send;
    window.ReactNativeWebView?.postMessage(JSON.stringify({ log: 'Shimming XMLHttpRequest.send' }));
      window.XMLHttpRequest.prototype.send = function(body) {
      // do something with the body
      window.ReactNativeWebView.postMessage(JSON.stringify({ 
        type: 'xhrSending', 
        body, 
        url: this.responseURL 
      }));


      this.addEventListener('load', function() {
        let body = ''
        try {
          body = JSON.parse(this.responseText)
        } catch (e) {
          body = this.responseText
        }
        window.ReactNativeWebView.postMessage(JSON.stringify({ 
          type: 'xhrSent', 
          url: this.responseURL,
          mimeType: this.getResponseHeader('Content-Type') || '',
          body 
        }));
      });
                    
      return window.oldXHRSend.apply(this, arguments);
    }
  } 
  true;
`
