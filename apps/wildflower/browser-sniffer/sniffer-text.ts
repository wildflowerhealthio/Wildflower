export default `
// oxlint-disable @typescript-eslint/no-unsafe-assignment @eslint-plugin-unicorn/consistent-function-scoping

;(function () {
  const makeRequestId = () => (Math.random() + 1).toString(36).slice(2)
  const headersToObject = (headers) => {
    if ('entries' in headers && typeof headers.entries === 'function') {
      return Object.fromEntries(headers.entries())
    }
    return headers
  }
  const post = (msg) => {
    if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
      window.ReactNativeWebView.postMessage(JSON.stringify(msg))
    }
  }
  const toBase64 = (input) => {
    if (typeof input === 'string') {
      return btoa(
        Array.from(new TextEncoder().encode(input), (b) => String.fromCharCode(b)).join('')
      )
    }
    return btoa(
      Array.from(new Uint8Array(input.buffer || input), (b) => String.fromCharCode(b)).join('')
    )
  }

  // Track in-progress request IDs so they can be cancelled
  const activeRequests = new Set()

  // Global method to cancel skimming a request by ID.
  // Silently removes the request from tracking so no further data/finished messages are posted.
  window.cancelSnifferRequest = function (id) {
    activeRequests.delete(id)
  }

  // Fetch shim
  if (!window.nativeFetch) {
    post({ _tag: 'Log', log: 'Shimming fetch' })
    window.nativeFetch = window.fetch

    window.fetch = async function (request, init) {
      const requestId = makeRequestId()
      let url
      let response

      try {
        if (typeof request === 'string') {
          url = request
          const req = new Request(request, init)
          response = await window.nativeFetch(req)
          response.requestInputObject = req
        } else {
          url = request.url
          response = await window.nativeFetch(request, init)
          response.requestInputObject = request
        }
      } catch (err) {
        let errorUrl
        if (url) {
          errorUrl = url
        } else if (typeof request === 'string') {
          errorUrl = request
        } else {
          errorUrl = request.url
        }
        post({
          _tag: 'RequestError',
          id: requestId,
          url: errorUrl,
          message: err.message,
        })
        throw err
      }

      activeRequests.add(requestId)

      post({
        _tag: 'ResponseStart',
        id: requestId,
        url,
        status: response.status,
        statusText: response.statusText,
        headers: headersToObject(response.headers),
      })

      if (response.body) {
        const ts = new TransformStream({
          transform(chunk, controller) {
            if (!activeRequests.has(requestId)) {
              controller.enqueue(chunk)
              return
            }
            post({
              _tag: 'ResponseData',
              id: requestId,
              data: toBase64(chunk),
            })
            controller.enqueue(chunk)
          },
          flush() {
            if (!activeRequests.has(requestId)) return
            activeRequests.delete(requestId)
            post({ _tag: 'ResponseFinished', id: requestId })
          },
        })
        response = new Response(response.body.pipeThrough(ts), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      } else {
        activeRequests.delete(requestId)
        post({ _tag: 'ResponseFinished', id: requestId })
      }

      if (typeof request === 'string') {
        response.requestInputURL = request
      }
      if (init) {
        response.requestInputHeaders = init
      }

      return response
    }
  }

  // XHR shim
  if (!window.nativeXHROpen) {
    post({ _tag: 'Log', log: 'Shimming XMLHttpRequest' })
    window.nativeXHROpen = window.XMLHttpRequest.prototype.open.bind(
      window.XMLHttpRequest.prototype
    )
    window.nativeXHRSend = window.XMLHttpRequest.prototype.send.bind(
      window.XMLHttpRequest.prototype
    )

    window.XMLHttpRequest.prototype.open = function (method, url) {
      this._snifferId = makeRequestId()
      this._snifferUrl = url
      this._snifferSentBytes = 0
      return window.nativeXHROpen.apply(this, arguments)
    }

    window.XMLHttpRequest.prototype.send = function (body) {
      const requestId = this._snifferId
      let startSent = false

      activeRequests.add(requestId)

      const ensureStartSent = (xhr) => {
        if (startSent) return
        startSent = true
        let headers = {}
        if (xhr.getAllResponseHeaders) {
          headers = headersToObject(
            Object.fromEntries(
              xhr
                .getAllResponseHeaders()
                .trim()
                .split(/\\r?\\n/)
                .filter(Boolean)
                .map((line) => {
                  const idx = line.indexOf(':')
                  return [line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim()]
                })
            )
          )
        }
        post({
          _tag: 'ResponseStart',
          id: requestId,
          url: xhr._snifferUrl,
          status: xhr.status,
          statusText: xhr.statusText,
          headers,
        })
      }

      this.addEventListener('progress', () => {
        // Guard against stale listeners from XHR reuse
        if (this._snifferId !== requestId) return
        if (!activeRequests.has(requestId)) return
        ensureStartSent(this)
        if (this.responseType === '' || this.responseType === 'text') {
          const chunk = this.responseText.slice(this._snifferSentBytes)
          if (chunk) {
            post({ _tag: 'ResponseData', id: requestId, data: toBase64(chunk) })
            this._snifferSentBytes = this.responseText.length
          }
        }
      })

      this.addEventListener(
        'load',
        () => {
          if (this._snifferId !== requestId) return
          if (!activeRequests.has(requestId)) return
          ensureStartSent(this)
          // Flush any remaining text not captured by progress
          if (this.responseType === '' || this.responseType === 'text') {
            const chunk = this.responseText.slice(this._snifferSentBytes)
            if (chunk) {
              post({ _tag: 'ResponseData', id: requestId, data: toBase64(chunk) })
            }
          }
          activeRequests.delete(requestId)
          post({ _tag: 'ResponseFinished', id: requestId })
        },
        { once: true }
      )

      this.addEventListener(
        'error',
        () => {
          activeRequests.delete(requestId)
          post({
            _tag: 'RequestError',
            id: requestId,
            url: this._snifferUrl,
            message: 'XMLHttpRequest error',
          })
        },
        { once: true }
      )
      this.addEventListener(
        'abort',
        () => {
          activeRequests.delete(requestId)
          post({ _tag: 'ResponseFinished', id: requestId })
        },
        { once: true }
      )

      return window.nativeXHRSend.apply(this, arguments)
    }
  }

  // Page content capture on load
  if (!window._snifferPageLoadHandler) {
    window._snifferPageLoadHandler = () => {
      post({
        _tag: 'PageLoaded',
        url: window.location.href,
        content: document.documentElement.outerHTML,
      })
    }
    window.addEventListener('load', window._snifferPageLoadHandler)
  }

  return true
})();
true;
`
