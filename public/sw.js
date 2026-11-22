// 서비스 워커: 앱 파일(화면·모델·WASM)을 이 컴퓨터에 저장해 두어 오프라인에서도 열리게 한다(PWA).
// - 같은 도메인의 GET 요청만 다룬다. 영상·얼굴 정보는 애초에 요청으로 나가지 않으며, 여기서도 어디로도 보내지 않는다.
// - 저장할 파일 목록(precache-manifest.js)은 빌드할 때 만들어진다.
importScripts('/precache-manifest.js')

const { version, files } = self.__PRECACHE
const PREFIX = 'mosaic-'
const CACHE = `${PREFIX}${version}`

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      // 큰 파일(WASM)이 있으므로 한꺼번에 받지 않고 하나씩 받는다. 하나라도 실패하면 설치를 다음에 다시 시도한다.
      for (const file of files) {
        const response = await fetch(file, { cache: 'reload' })
        if (!response.ok) throw new Error(`오프라인용 파일을 받지 못했습니다: ${file} (${response.status})`)
        await cache.put(file, response)
      }
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 예전 버전의 저장분을 지운다.
      for (const name of await caches.keys()) {
        if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name)
      }
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE)
      if (request.mode === 'navigate') {
        // 화면 이동(주소창·새로 고침)은 먼저 서버에서 최신 첫 화면을 받는다. 그래야 새로 배포한 버전이 바로 쓰인다
        // (예전에는 저장해 둔 옛 화면을 먼저 보여 줘서, 고친 오류가 한 번 더 나타났다). 오프라인이면 저장분으로 연다.
        try {
          const fresh = await fetch(request, { cache: 'no-store' })
          if (fresh.ok) return fresh
        } catch {
          // 오프라인: 아래에서 저장분으로 답한다.
        }
        return (await cache.match('/index.html')) ?? fetch(request)
      }
      const cached = await cache.match(url.pathname)
      if (cached) return cached
      return fetch(request)
    })(),
  )
})
