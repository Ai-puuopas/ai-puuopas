# AI-puuopas

Cloudflare Worker -taustapalvelu JuKiPuun AI-puuoppaalle.

Julkinen käyttöliittymä käynnistyy suoraan JuKiPuun sivustolta:

<https://jukipuu.fi/ai-puuopas/public/>

Cloudflare Worker palvelee koko sovelluksen tämän sivustopolun kautta. Polun
alla toimivat käyttöliittymä, kuvatunnistus, kuntoarvio ja API-kutsut samalla
alkuperällä. Vanha workers.dev-juuriosoite ohjaa käyttäjän kanoniseen
JuKiPuu-osoitteeseen, mutta sen API-reitit eivät ole käytettävissä.
Versioiden esikatseluosoitteet on poistettu käytöstä, jotta API toimii vain
JuKiPuun WAF-suojatun sivustoreitin kautta.

## Kuvan liittäminen keskusteluun

Tiedosto `public/puuopas-chat.js` lisää nykyiseen keskustelukenttään:

- kuvan liittämisen paste-komennolla (Ctrl/⌘ + V)
- kuvapainikkeen ja esikatselun
- kasvin, puun, sienen tai tuholaisen kuvatunnistuksen
- “Tunnista puu” -kortille ohjatun kolmen kuvan tunnistuksen järjestyksessä:
  lehti tai silmu, runko ja lopuksi yleiskuva
- lähetyksen jälkeisen etenemisilmaisimen, kuluneen ajan ja arvion siitä, että
  tietojen haku ja tarkistus voi kestää noin 1–1,5 minuuttia
- saman viiden keskustelukierroksen muistin myös sivujen välisissä API-kutsuissa

Lisää moduuli Puuoppaan HTML-sivun loppuun ennen `</body>`-tagia:

```html
<script src="https://jukipuu.fi/ai-puuopas/public/puuopas-chat.js"></script>
```

Selain pienentää kuvan ennen lähettämistä. Rajapinta hyväksyy JPG-, PNG- ja
WebP-kuvat, joiden koko on enintään 5 Mt. Kolmen puukuvan yhteiskoko saa olla
enintään 12 Mt. Kuvien sisältöä ei tallenneta keskustelumuistiin.

Kolmen kuvan tunnistuksessa kaikki kuvapaikat täytetään ennen tunnistuksen
käynnistämistä. GPT-5.6 Sol rajaa kandidaatit ensin lehden tai silmun avulla,
karsii niitä rungon tuntomerkeillä ja käyttää yleiskuvaa lopullisena
järkevyystarkistuksena. Epävarmassa tapauksessa AI pyytää yhden ratkaisevan
lisäkuvan konkreettisella kuvausohjeella.

Normaali kolmen kuvan tunnistus käyttää GPT-5.6 Solin medium-päättelyä ja
tiivistä vastausta. Yleiskuva käsitellään kevyemmin kuin lehti tai silmu ja
runko. Jos ensimmäisen vastauksen varmuusarvio on epävarma, sama aineisto
tarkistetaan automaattisesti high-päättelyllä.

Versiosta 0.14 alkaen teksti- ja yhden kuvan vastaukset suoratoistetaan
selaimelle niiden valmistuessa. Kolmen kuvan tunnistus näytetään vasta
kokonaisena, jotta mahdollinen high-tarkistus ei vaihda käyttäjälle jo näytettyä
lajipäätelmää. Kuvien data käsitellään varsinaisessa Workerissa; keskustelun
Durable Object siirtää vain pienen tekstihistorian.

AI Search käyttää nykyistä Workers binding -rajapintaa, hybridihakua, kolmen
tuloksen relevanssirajaa, läheisten kysymysten välimuistia ja
keskustelukohtaista mallin session affinityä. Kalliita AI-kutsuja ja
kuntoarvion kirjautumista suojaavat erilliset Cloudflare Rate Limiting
-sidonnat.
Worker tallentaa Analytics Engineen vain tekniset suorituskykymittarit, kuten
toimintatilan, vaiheiden kestot, tokenimäärät ja kuvien yhteiskoon. Kysymysten,
vastausten tai kuvien sisältöä ei tallenneta analytiikkapisteisiin.

## Kuntoarvion raakaversio

“Tee kuntoarvio” -kortti avaa JuKiPuun kuntoarviopohjaan perustuvan ohjatun
lomakkeen salasanan tarkistamisen jälkeen. Salasana säilytetään vain Cloudflare
Workerin salaisuutena eikä sitä kirjoiteta selaimen lähdekoodiin tai GitHubiin.
Hyväksytty istunto on voimassa kahdeksan tuntia ja unohtuu sivun latautuessa
uudelleen. Kansisivulle vaaditaan puun yleiskuva. Tyven ja ympäristön, rungon
sekä latvuksen kuvat ovat valinnaisia. Käyttäjä voi lisätä tunnetut kohde- ja
mittatiedot, minkä jälkeen AI laatii jäsennellyn alustavan luonnoksen.
Sijainti voidaan kirjoittaa itse tai lukea puhelimesta käyttäjän painaessa
“Hae nykyinen sijainti” -painiketta ja hyväksyessä selaimen sijaintiluvan.
Raporttiin tallennetaan WGS84-koordinaatit sekä puhelimen ilmoittama arvioitu
tarkkuus. Sijaintitieto on suuntaa-antava eikä osoita oikeudellisesti tarkkaa
tonttirajaa.

Luonnos näytetään tulostettavana raporttina, jonka ensimmäisellä sivulla on
puun yleiskuva. Selaimen tulostustoiminnolla raportin voi tallentaa PDF:ksi.
Luonnos ei korvaa paikan päällä tehtävää arboristin kuntoarviota.

Kuntoarvio on salasanasuojattu arboristin sisäinen työkalu. Lomakkeeseen
kirjoitetut kommentit käsitellään arboristin ammattihavaintoina. AI:n kuvista
tekemät uudet tulkinnat ja lisäysehdotukset näytetään erillisinä Kyllä/Ei-
valintoina. Vain arboristin Kyllä-valinnalla hyväksymät ehdotukset lisätään
tulostettavaan raporttiin.
