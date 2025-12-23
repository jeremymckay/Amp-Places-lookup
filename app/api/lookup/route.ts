import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

export const runtime = 'nodejs'

const PLACES_V1_BASE = 'https://places.googleapis.com/v1'

// Basic in-memory rate limiter per IP
const WINDOW_MS = 60_000
const MAX_REQUESTS = 30
const buckets = new Map<string, number[]>()

function getIp(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  return (req as any).ip ?? 'unknown'
}

function rateLimit(req: NextRequest): string | null {
  const ip = getIp(req)
  const now = Date.now()
  const arr = buckets.get(ip) ?? []
  const recent = arr.filter((t) => now - t < WINDOW_MS)
  recent.push(now)
  buckets.set(ip, recent)
  if (recent.length > MAX_REQUESTS) {
    return 'Rate limit exceeded. Please try again shortly.'
  }
  return null
}

const BodySchema = z.object({
  address: z.string().trim().min(1, 'Address is required'),
  selectedIndex: z.number().int().min(0).optional(),
})

const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY

const PLACE_FIELD_MASK = [
  'id',
  'displayName',
  'formattedAddress',
  'addressComponents',
  'location',
  'viewport',
  'types',
  'primaryType',
  'primaryTypeDisplayName',
  'businessStatus',
  'priceLevel',
  'priceRange',
  'rating',
  'userRatingCount',
  'nationalPhoneNumber',
  'internationalPhoneNumber',
  'websiteUri',
  'googleMapsUri',
  'regularOpeningHours',
  'utcOffsetMinutes',
  'takeout',
  'delivery',
  'dineIn',
  'curbsidePickup',
  'reservable',
  'servesBreakfast',
  'servesLunch',
  'servesDinner',
  'servesBrunch',
  'servesBeer',
  'servesWine',
  'servesCocktails',
  'servesCoffee',
  'servesDessert',
  'servesVegetarianFood',
  'outdoorSeating',
  'liveMusic',
  'menuForChildren',
  'goodForChildren',
  'goodForGroups',
  'goodForWatchingSports',
  'allowsDogs',
  'restroom',
  'accessibilityOptions',
  'paymentOptions',
  'parkingOptions',
  'editorialSummary',
].join(',')

async function fetchPlaceDetailsNew(placeId: string): Promise<any> {
  const url = new URL(`${PLACES_V1_BASE}/places/${placeId}`)
  const resp = await fetch(url.toString(), {
    headers: {
      'X-Goog-Api-Key': GOOGLE_KEY!,
      'X-Goog-FieldMask': PLACE_FIELD_MASK,
    },
  })

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Places v1 details failed with status ${resp.status}${text ? `: ${text}` : ''}`)
  }

  return resp.json()
}

export async function POST(req: NextRequest) {
  const rl = rateLimit(req)
  if (rl) {
    return NextResponse.json({ error: rl }, { status: 429 })
  }

  if (!GOOGLE_KEY) {
    return NextResponse.json({ error: 'Server is not configured with GOOGLE_MAPS_API_KEY' }, { status: 500 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const started = Date.now()
  const { address, selectedIndex } = parsed.data
  const warnings: string[] = []

  // 1) Geocoding
  const geocodeUrl = new URL('https://maps.googleapis.com/maps/api/geocode/json')
  geocodeUrl.searchParams.set('address', address)
  geocodeUrl.searchParams.set('key', GOOGLE_KEY!)

  const geoRes = await fetch(geocodeUrl.toString())
  if (!geoRes.ok) {
    return NextResponse.json({ error: `Geocoding failed with status ${geoRes.status}` }, { status: 502 })
  }
  const geoData = await geoRes.json()

  if (!Array.isArray(geoData.results) || geoData.results.length === 0) {
    return NextResponse.json(
      {
        geocode: { query: address, candidates: [], selectedIndex: 0 },
        place: null,
        warnings: ['No match found.'],
      },
      { status: 200 }
    )
  }

  const candidates = geoData.results.map((r: any) => ({
    formatted_address: r.formatted_address,
    place_id: r.place_id ?? null,
    lat: r.geometry?.location?.lat ?? null,
    lng: r.geometry?.location?.lng ?? null,
    address_components: r.address_components ?? null,
  }))

  if (candidates.length > 1) warnings.push('Multiple matches found; showing best match.')

  const idx = typeof selectedIndex === 'number' && selectedIndex >= 0 && selectedIndex < candidates.length ? selectedIndex : 0

  let place: any = null
  const chosen = candidates[idx]
  if (!chosen.place_id) {
    warnings.push('No place_id from geocoding; place details not available.')
  } else {
    // 3) Place details (Places API (New) v1)
    try {
      place = await fetchPlaceDetailsNew(chosen.place_id)
      warnings.push('Places details returned from Places API (New); attribute availability varies by place.')
    } catch (e: any) {
      warnings.push(e?.message ?? 'Place details fetch failed')
    }
  }

  const elapsed = Date.now() - started
  return NextResponse.json({
    geocode: { query: address, candidates, selectedIndex: idx },
    place,
    warnings,
    latencyMs: elapsed,
  })
}

// Same route path used to proxy Photo API to avoid exposing API key
export async function GET(req: NextRequest) {
  const rl = rateLimit(req)
  if (rl) return new NextResponse(rl, { status: 429 })
  if (!GOOGLE_KEY) return new NextResponse('Server not configured', { status: 500 })

  const { searchParams } = new URL(req.url)
  const photoName = searchParams.get('photoName') ?? searchParams.get('name') ?? searchParams.get('photoRef')
  const maxWidthPx = searchParams.get('maxWidthPx') ?? searchParams.get('maxwidth') ?? '400'
  const maxHeightPx = searchParams.get('maxHeightPx') ?? searchParams.get('maxheight')
  if (!photoName) return new NextResponse('photoName required', { status: 400 })

  // Places API (New) photo media endpoint expects a full resource name like:
  // places/{placeId}/photos/{photoReference}
  // If the caller passes a full name, use it directly.
  if (!photoName.startsWith('places/')) {
    return new NextResponse('photoName must be a full Places photo resource name (starts with "places/")', {
      status: 400,
    })
  }

  const photoUrl = new URL(`${PLACES_V1_BASE}/${photoName}/media`)
  photoUrl.searchParams.set('maxWidthPx', maxWidthPx)
  if (maxHeightPx) photoUrl.searchParams.set('maxHeightPx', maxHeightPx)
  photoUrl.searchParams.set('skipHttpRedirect', 'true')

  const resp = await fetch(photoUrl.toString(), {
    headers: {
      'X-Goog-Api-Key': GOOGLE_KEY!,
    },
    redirect: 'manual',
  })

  // When skipHttpRedirect=true, Places returns JSON containing the actual media URL.
  if (resp.ok && (resp.headers.get('content-type') ?? '').includes('application/json')) {
    const data = await resp.json().catch(() => null)
    const mediaUrl = data?.photoUri
    if (!mediaUrl) return new NextResponse('Failed to resolve photo media URL', { status: 502 })
    const mediaResp = await fetch(mediaUrl)
    if (!mediaResp.ok) return new NextResponse('Failed to fetch photo', { status: 502 })
    const contentType = mediaResp.headers.get('content-type') ?? 'image/jpeg'
    const arrayBuffer = await mediaResp.arrayBuffer()
    return new NextResponse(Buffer.from(arrayBuffer), {
      status: 200,
      headers: {
        'content-type': contentType,
        'cache-control': 'public, max-age=86400',
      },
    })
  }

  // Some responses may redirect directly if skipHttpRedirect is ignored.
  if (resp.status >= 300 && resp.status < 400) {
    const loc = resp.headers.get('location')
    if (!loc) return new NextResponse('Failed to fetch photo', { status: 502 })
    const mediaResp = await fetch(loc)
    if (!mediaResp.ok) return new NextResponse('Failed to fetch photo', { status: 502 })
    const contentType = mediaResp.headers.get('content-type') ?? 'image/jpeg'
    const arrayBuffer = await mediaResp.arrayBuffer()
    return new NextResponse(Buffer.from(arrayBuffer), {
      status: 200,
      headers: {
        'content-type': contentType,
        'cache-control': 'public, max-age=86400',
      },
    })
  }

  if (!resp.ok) return new NextResponse('Failed to fetch photo', { status: 502 })

  const contentType = resp.headers.get('content-type') ?? 'image/jpeg'
  const arrayBuffer = await resp.arrayBuffer()
  return new NextResponse(Buffer.from(arrayBuffer), {
    status: 200,
    headers: {
      'content-type': contentType,
      'cache-control': 'public, max-age=86400',
    },
  })
}
