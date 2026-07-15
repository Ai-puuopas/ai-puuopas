# AI-puuopas

Cloudflare Worker -taustapalvelu JuKiPuun AI-puuoppaalle.

## Kuvan liittäminen keskusteluun

Tiedosto `public/puuopas-chat.js` lisää nykyiseen keskustelukenttään:

- kuvan liittämisen paste-komennolla (Ctrl/⌘ + V)
- kuvapainikkeen ja esikatselun
- kasvin, puun, sienen tai tuholaisen kuvatunnistuksen
- saman viiden keskustelukierroksen muistin myös sivujen välisissä API-kutsuissa

Lisää moduuli Puuoppaan HTML-sivun loppuun ennen `</body>`-tagia:

```html
<script src="https://ai-puuopas.jukipuu-fi.workers.dev/puuopas-chat.js"></script>
```

Selain pienentää kuvan ennen lähettämistä. Rajapinta hyväksyy JPG-, PNG- ja
WebP-kuvat, joiden koko on enintään 5 Mt. Kuvan sisältöä ei tallenneta
keskustelumuistiin.
