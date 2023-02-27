/*
 Copyright 2022 Google LLC

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

      https://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
 */

// SSP
import express from "express"
import url from "url"
import cbor from "cbor"
import {
  debugKey,
  sourceEventId,
  sourceKeyPiece,
  triggerKeyPiece,
  ADVERTISER,
  PUBLISHER,
  DIMENSION,
  decodeBucket,
  SOURCE_TYPE,
  TRIGGER_TYPE
} from "./arapi.js"

const port = "3000" // "fixed for internal port"
const host = process.env.SSP_HOST || "ssp.localhost"
const token = process.env.SSP_TOKEN || ""

// global memory storage
const Reports = []

const app = express()

app.use((req, res, next) => {
  res.setHeader("Origin-Trial", token)
  next()
})

app.use(express.json())

app.use((req, res, next) => {
  // enable debug mode
  res.cookie("ar_debug", "1", {
    sameSite: "none",
    secure: true,
    httpOnly: true
  })
  next()
})

app.use((req, res, next) => {
  // opt-in fencedframe
  if (req.get("sec-fetch-dest") === "fencedframe") {
    res.setHeader("Supports-Loading-Mode", "fenced-frame")
  }
  next()
})

app.use(
  express.static("src/public", {
    setHeaders: (res, path, stat) => {
      if (path.endsWith("/decision-logic.js")) {
        return res.set("X-Allow-FLEDGE", "true")
      }
      if (path.endsWith("/run-ad-auction.js")) {
        res.set("Supports-Loading-Mode", "fenced-frame")
        res.set("Permissions-Policy", "run-ad-auction=(*)")
      }
    }
  })
)
app.set("view engine", "ejs")
app.set("views", "src/views")

app.get("/", async (req, res) => {
  const title = process.env.SSP_DETAIL || host
  res.render("index.html.ejs", { title })
})

app.get("/ads", async (req, res) => {
  const { advertiser, id } = req.query
  console.log({ advertiser, id })

  const title = `Your special ads from ${advertiser}`
  const host = process.env.SSP_HOST
  const port = process.env.PORT

  const href = new URL(`https://${host}:${port}/move`)
  href.searchParams.append("advertiser", advertiser)
  href.searchParams.append("id", id)

  const src = new URL(`https://${host}:${port}/creative`)
  src.searchParams.append("advertiser", advertiser)
  src.searchParams.append("id", id)

  res.render("ads.html.ejs", { title, href, src })
})

app.get("/move", async (req, res) => {
  const { advertiser, id } = req.query
  console.log({ advertiser, id })
  const url = `https://${advertiser}.web.app/items/${id}`
  if (req.headers["attribution-reporting-eligible"]) {
    const are = req.headers["attribution-reporting-eligible"].split(",").map((e) => e.trim())
    if (are.includes("navigation-source")) {
      const destination = `https://${advertiser}.web.app`
      const source_event_id = sourceEventId()
      const debug_key = debugKey()
      const AttributionReportingRegisterSource = {
        destination,
        source_event_id,
        debug_key,
        aggregation_keys: {
          quantity: sourceKeyPiece({
            type: SOURCE_TYPE["click"], // click attribution
            advertiser: ADVERTISER[advertiser],
            publisher: PUBLISHER["news"],
            id: Number(`0x${id}`),
            dimension: DIMENSION["quantity"]
          }),
          gross: sourceKeyPiece({
            type: SOURCE_TYPE["click"], // click attribution
            advertiser: ADVERTISER[advertiser],
            publisher: PUBLISHER["news"],
            id: Number(`0x${id}`),
            dimension: DIMENSION["gross"]
          })
        }
      }

      console.log({ AttributionReportingRegisterSource })
      res.setHeader("Attribution-Reporting-Register-Source", JSON.stringify(AttributionReportingRegisterSource))
    }
  }

  res.redirect(302, url)
})

app.get("/creative", async (req, res) => {
  const { advertiser, id } = req.query

  if (req.headers["attribution-reporting-eligible"]) {
    // TODO: better to add attributionsrc to <a> or other not <img> ?
    const are = req.headers["attribution-reporting-eligible"].split(",").map((e) => e.trim())
    if (are.includes("event-source") && are.includes("trigger")) {
      const destination = `https://${advertiser}.web.app`
      const source_event_id = sourceEventId()
      const debug_key = debugKey()
      const AttributionReportingRegisterSource = {
        destination,
        source_event_id,
        debug_key,
        aggregation_keys: {
          quantity: sourceKeyPiece({
            type: SOURCE_TYPE["view"], // view attribution
            advertiser: ADVERTISER[advertiser],
            publisher: PUBLISHER["news"],
            id: Number(`0x${id}`),
            dimension: DIMENSION["quantity"]
          }),
          gross: sourceKeyPiece({
            type: SOURCE_TYPE["view"], // view attribution
            advertiser: ADVERTISER[advertiser],
            publisher: PUBLISHER["news"],
            id: Number(`0x${id}`),
            dimension: DIMENSION["gross"]
          })
        }
      }

      console.log({ AttributionReportingRegisterSource })
      res.setHeader("Attribution-Reporting-Register-Source", JSON.stringify(AttributionReportingRegisterSource))
    }
  }
  const img = `public/img/${advertiser}/emoji_u${id}.svg`
  const path = url.fileURLToPath(new URL(img, import.meta.url))
  res.status(200).sendFile(path)
})

app.get("/register-trigger", async (req, res) => {
  const { id, quantity, size, category, gross } = req.query

  const AttributionReportingRegisterTrigger = {
    aggregatable_trigger_data: [
      {
        key_piece: triggerKeyPiece({
          type: TRIGGER_TYPE["quantity"],
          id: parseInt(id, 16),
          size: Number(size),
          category: Number(category),
          option: 0
        }),
        source_keys: ["quantity"]
      },
      {
        key_piece: triggerKeyPiece({
          type: TRIGGER_TYPE["gross"],
          id: parseInt(id, 16),
          size: Number(size),
          category: Number(category),
          option: 0
        }),
        source_keys: ["gross"]
      }
    ],
    aggregatable_values: {
      // TODO: scaling
      quantity: Number(quantity),
      gross: Number(gross)
    },
    debug_key: debugKey()
  }
  res.setHeader("Attribution-Reporting-Register-Trigger", JSON.stringify(AttributionReportingRegisterTrigger))
  res.sendStatus(200)
})

app.get("/ad-tag.html", async (req, res) => {
  res.render("ad-tag.html.ejs")
})

app.get("/reports", async (req, res) => {
  res.render("reports.html.ejs", { title: "Report", Reports })
})

app.post("/.well-known/attribution-reporting/debug/report-aggregate-attribution", async (req, res) => {
  const debug_report = req.body
  debug_report.shared_info = JSON.parse(debug_report.shared_info)

  console.log(JSON.stringify(debug_report, " ", " "))

  debug_report.aggregation_service_payloads = debug_report.aggregation_service_payloads.map((e) => {
    const plain = Buffer.from(e.debug_cleartext_payload, "base64")
    const debug_cleartext_payload = cbor.decodeAllSync(plain)
    e.debug_cleartext_payload = debug_cleartext_payload.map(({ data, operation }) => {
      return {
        operation,
        data: data.map(({ value, bucket }) => {
          return {
            value: value.readUInt32BE(0),
            bucket: decodeBucket(bucket)
          }
        })
      }
    })
    return e
  })

  console.log(JSON.stringify(debug_report, " ", " "))

  // save to global storage
  Reports.push(debug_report)

  res.sendStatus(200)
})

app.post("/.well-known/attribution-reporting/report-aggregate-attribution", async (req, res) => {
  const report = req.body
  report.shared_info = JSON.parse(report.shared_info)
  console.log(JSON.stringify(report, " ", " "))
  res.sendStatus(200)
})

app.listen(port, function () {
  console.log(`Listening on port ${port}`)
})
