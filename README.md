# AI-puuopas

Cloudflare Worker -taustapalvelu JuKiPuun AI-puuoppaalle.

Julkinen käyttöliittymä:

<https://ai-puuopas.jukipuu-fi.workers.dev/>

## Kuvan liittäminen keskusteluun

Tiedosto `public/puuopas-chat.js` lisää nykyiseen keskustelukenttään:

- kuvan liittämisen paste-komennolla (Ctrl/⌘ + V)
- kuvapainikkeen ja esikatselun
- kasvin, puun, sienen tai tuholaisen kuvatunnistuksen
- “Tunnista puu” -kortille kolmen kuvan tunnistuksen: yleiskuva, runko ja
  lehti tai silmu
- saman viiden keskustelukierroksen muistin myös sivujen välisissä API-kutsuissa

Lisää moduuli Puuoppaan HTML-sivun loppuun ennen `</body>`-tagia:

```html
<script src="https://ai-puuopas.jukipuu-fi.workers.dev/puuopas-chat.js"></script>
```

Selain pienentää kuvan ennen lähettämistä. Rajapinta hyväksyy JPG-, PNG- ja
WebP-kuvat, joiden koko on enintään 5 Mt. Kolmen puukuvan yhteiskoko saa olla
enintään 12 Mt. Kuvien sisältöä ei tallenneta keskustelumuistiin.

Kolmen kuvan tunnistuksessa kaikki kuvapaikat täytetään ennen tunnistuksen
käynnistämistä. AI käsittelee kuvat nimettyinä, vertailee tuntomerkkejä ja
ilmoittaa todennäköisimmän lajin, vaihtoehdot sekä tunnistuksen varmuuden.
