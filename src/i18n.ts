// i18n — the produced site's LANGUAGE is a build property, decided once and forced everywhere.
// The LLM already writes headlines/products in the brief's language; what was broken is the
// CHROME — buttons, form labels, cart, receipts, account — hardcoded English by the renderers.
// Relay rules apply: a CLOSED locale set, a deterministic detector (stopword scoring — no LLM
// vote on identity), one string table whose completeness is machine-gated (a missing key in any
// locale fails the suite), and 'en' as the unchanged default so every existing site renders
// byte-identical without a locale.
export const LOCALES = ['en', 'it', 'fr', 'es', 'de'] as const;
export type Locale = typeof LOCALES[number];

export function isLocale(x: any): x is Locale { return LOCALES.includes(x); }

// deterministic language detection over the brief: weighted stopword/marker scoring.
// Distinctive domain words weigh 3, unique function words 1. The winner must clear a floor
// AND beat English — anything ambiguous stays English (never guess a client's language).
const MARKERS: Record<Exclude<Locale, 'en'>, { w3: string[]; w1: string[] }> = {
  it: { w3: ['prenotazion', 'negozio', 'ristorante', 'parrucchier', 'pasticceria', 'abbigliamento', 'ricette', 'azienda', 'settimana'],
        w1: ['il', 'la', 'di', 'che', 'per', 'con', 'una', 'della', 'del', 'gli', 'sono', 'anche', 'dove', 'nel'] },
  fr: { w3: ['réservation', 'boutique', 'coiffeur', 'pâtisserie', 'entreprise', 'recettes', 'semaine', 'vêtements'],
        w1: ['le', 'la', 'les', 'des', 'une', 'avec', 'pour', 'et', 'du', 'aux', 'chez', 'où', 'être', 'sur'] },
  es: { w3: ['reserva', 'tienda', 'peluquer', 'pasteler', 'empresa', 'recetas', 'semana', 'ropa'],
        w1: ['el', 'los', 'las', 'una', 'con', 'para', 'y', 'del', 'donde', 'también', 'que', 'en'] },
  de: { w3: ['buchung', 'geschäft', 'friseur', 'bäckerei', 'unternehmen', 'rezepte', 'woche', 'kleidung', 'termine'],
        w1: ['der', 'die', 'das', 'und', 'mit', 'für', 'ein', 'eine', 'einen', 'auch', 'wo', 'bei', 'zum'] },
};
const EN_W1 = ['the', 'a', 'an', 'and', 'with', 'for', 'of', 'to', 'that', 'where', 'their', 'customers'];

export function detectLocale(text: string): Locale {
  const t = ' ' + String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ') + ' ';
  // (^|\\P{L}) unicode boundary — JS \\b is ASCII-only, so an accent-initial marker like 'être' never matched
  const hits = (w: string) => (t.match(new RegExp('(?:^|\\P{L})' + w.replace(/[.*+?^${}()|[\]\\]/g, ''), 'gu')) || []).length;
  const en = EN_W1.reduce((n, w) => n + hits(w), 0);
  let best: Locale = 'en', bestScore = 0;
  for (const loc of Object.keys(MARKERS) as Array<Exclude<Locale, 'en'>>) {
    const m = MARKERS[loc];
    const score = m.w3.reduce((n, w) => n + 3 * hits(w), 0) + m.w1.reduce((n, w) => n + hits(w), 0);
    if (score > bestScore) { best = loc; bestScore = score; }
  }
  return bestScore >= 3 && bestScore > en ? best : 'en';
}

// the ONE chrome string table. Key order matters to nobody; completeness matters to the gate.
export const STRINGS: Record<string, Record<Locale, string>> = {
  toggle_menu:      { en: 'Toggle menu', it: 'Apri il menu', fr: 'Ouvrir le menu', es: 'Abrir el menú', de: 'Menü öffnen' },
  loading:          { en: 'Loading the collection…', it: 'Caricamento in corso…', fr: 'Chargement en cours…', es: 'Cargando…', de: 'Wird geladen…' },
  cart_empty:       { en: 'Your cart is empty.', it: 'Il tuo carrello è vuoto.', fr: 'Votre panier est vide.', es: 'Tu carrito está vacío.', de: 'Dein Warenkorb ist leer.' },
  how_youll_pay:    { en: "How you'll pay", it: 'Come pagherai', fr: 'Mode de paiement', es: 'Cómo pagarás', de: 'So bezahlst du' },
  full_name:        { en: 'Full name', it: 'Nome e cognome', fr: 'Nom complet', es: 'Nombre completo', de: 'Vollständiger Name' },
  email:            { en: 'Email', it: 'Email', fr: 'E-mail', es: 'Correo electrónico', de: 'E-Mail' },
  phone:            { en: 'Phone', it: 'Telefono', fr: 'Téléphone', es: 'Teléfono', de: 'Telefon' },
  notes:            { en: 'Notes', it: 'Note', fr: 'Remarques', es: 'Notas', de: 'Anmerkungen' },
  place_order:      { en: 'Place order', it: 'Invia ordine', fr: 'Passer la commande', es: 'Realizar pedido', de: 'Bestellung aufgeben' },
  back:             { en: 'Back', it: 'Indietro', fr: 'Retour', es: 'Volver', de: 'Zurück' },
  sold_out:         { en: 'Sold out', it: 'Esaurito', fr: 'Épuisé', es: 'Agotado', de: 'Ausverkauft' },
  only_n_left:      { en: 'Only {n} left', it: 'Solo {n} disponibili', fr: 'Plus que {n} en stock', es: 'Solo quedan {n}', de: 'Nur noch {n} verfügbar' },
  add_to_cart:      { en: 'Add to cart', it: 'Aggiungi al carrello', fr: 'Ajouter au panier', es: 'Añadir al carrito', de: 'In den Warenkorb' },
  view_cart:        { en: 'View cart →', it: 'Vai al carrello →', fr: 'Voir le panier →', es: 'Ver el carrito →', de: 'Zum Warenkorb →' },
  choose_options:   { en: 'Choose options', it: 'Scegli le opzioni', fr: 'Choisir les options', es: 'Elegir opciones', de: 'Optionen wählen' },
  pick_option:      { en: 'Pick an option first.', it: 'Prima scegli un’opzione.', fr: 'Choisissez d’abord une option.', es: 'Elige primero una opción.', de: 'Bitte zuerst eine Option wählen.' },
  remove:           { en: 'Remove', it: 'Rimuovi', fr: 'Retirer', es: 'Quitar', de: 'Entfernen' },
  total:            { en: 'Total', it: 'Totale', fr: 'Total', es: 'Total', de: 'Gesamt' },
  proceed_checkout: { en: 'Proceed to checkout', it: 'Vai alla cassa', fr: 'Passer à la caisse', es: 'Ir a la caja', de: 'Zur Kasse' },
  cart_empty_add:   { en: 'Your cart is empty — add something first.', it: 'Il carrello è vuoto — aggiungi prima qualcosa.', fr: 'Votre panier est vide — ajoutez d’abord un article.', es: 'Tu carrito está vacío — añade algo primero.', de: 'Der Warenkorb ist leer — lege zuerst etwas hinein.' },
  order_placed:     { en: '✓ Order placed — confirmation #', it: '✓ Ordine ricevuto — conferma n. ', fr: '✓ Commande passée — confirmation n° ', es: '✓ Pedido realizado — confirmación n.º ', de: '✓ Bestellung eingegangen — Bestätigung Nr. ' },
  total_sep:        { en: ' · total ', it: ' · totale ', fr: ' · total ', es: ' · total ', de: ' · Summe ' },
  added_ok:         { en: 'Added ✓', it: 'Aggiunto ✓', fr: 'Ajouté ✓', es: 'Añadido ✓', de: 'Hinzugefügt ✓' },
  thanks_msg:       { en: 'Thanks — we got your message.', it: 'Grazie — abbiamo ricevuto il tuo messaggio.', fr: 'Merci — nous avons bien reçu votre message.', es: 'Gracias — hemos recibido tu mensaje.', de: 'Danke — deine Nachricht ist angekommen.' },
  error_retry:      { en: 'Sorry, something went wrong — please try again.', it: 'Si è verificato un errore — riprova.', fr: 'Une erreur est survenue — veuillez réessayer.', es: 'Algo salió mal — inténtalo de nuevo.', de: 'Etwas ist schiefgelaufen — bitte erneut versuchen.' },
  generic_error:    { en: 'Something went wrong — please try again.', it: 'Qualcosa è andato storto — riprova.', fr: 'Une erreur est survenue — veuillez réessayer.', es: 'Algo salió mal — inténtalo de nuevo.', de: 'Etwas ist schiefgelaufen — bitte erneut versuchen.' },
  no_receipt_code:  { en: 'No receipt found for that code — check it and try again.', it: 'Nessuna ricevuta con quel codice — controlla e riprova.', fr: 'Aucun reçu pour ce code — vérifiez et réessayez.', es: 'No hay recibo con ese código — revísalo e inténtalo de nuevo.', de: 'Kein Beleg mit diesem Code — bitte prüfen und erneut versuchen.' },
  check_inbox:      { en: 'Check your inbox — your sign-in link is on its way.', it: 'Controlla la tua email — il link di accesso è in arrivo.', fr: 'Vérifiez votre boîte mail — le lien de connexion arrive.', es: 'Revisa tu correo — el enlace de acceso está en camino.', de: 'Sieh in dein Postfach — der Anmeldelink ist unterwegs.' },
  links_on_way:     { en: 'If we have anything under that address, the links are on their way.', it: 'Se esiste qualcosa con quell’indirizzo, i link sono in arrivo.', fr: 'Si cette adresse existe chez nous, les liens sont en route.', es: 'Si hay algo con esa dirección, los enlaces van en camino.', de: 'Falls unter dieser Adresse etwas existiert, sind die Links unterwegs.' },
  search_ph:        { en: 'Search…', it: 'Cerca…', fr: 'Rechercher…', es: 'Buscar…', de: 'Suchen…' },
  search_aria:      { en: 'Search this list', it: 'Cerca nell’elenco', fr: 'Rechercher dans la liste', es: 'Buscar en la lista', de: 'Liste durchsuchen' },
  from_price:       { en: 'From ', it: 'Da ', fr: 'À partir de ', es: 'Desde ', de: 'Ab ' },
  no_times:         { en: 'No times available that day — try another date.', it: 'Nessun orario disponibile quel giorno — prova un’altra data.', fr: 'Aucun horaire disponible ce jour-là — essayez une autre date.', es: 'No hay horas disponibles ese día — prueba otra fecha.', de: 'An diesem Tag keine Zeiten frei — bitte anderes Datum wählen.' },
  pick_date:        { en: 'Pick a date to see available times.', it: 'Scegli una data per vedere gli orari disponibili.', fr: 'Choisissez une date pour voir les horaires.', es: 'Elige una fecha para ver las horas disponibles.', de: 'Wähle ein Datum, um freie Zeiten zu sehen.' },
  add:              { en: 'Add', it: 'Aggiungi', fr: 'Ajouter', es: 'Añadir', de: 'Hinzufügen' },
  send:             { en: 'Send', it: 'Invia', fr: 'Envoyer', es: 'Enviar', de: 'Senden' },
  receipt_eyebrow:  { en: 'Request received', it: 'Richiesta ricevuta', fr: 'Demande reçue', es: 'Solicitud recibida', de: 'Anfrage erhalten' },
  receipt_title:    { en: 'We got it — here is your receipt', it: 'Fatto — ecco la tua ricevuta', fr: 'C’est noté — voici votre reçu', es: 'Listo — aquí está tu recibo', de: 'Angekommen — hier ist dein Beleg' },
  receipt_save_ref: { en: 'Save this reference code — it is the key to this page.', it: 'Conserva questo codice — è la chiave di questa pagina.', fr: 'Conservez ce code de référence — c’est la clé de cette page.', es: 'Guarda este código de referencia — es la llave de esta página.', de: 'Bewahre diesen Code auf — er ist der Schlüssel zu dieser Seite.' },
  receipt_lost:     { en: 'Lost the link? Retrieve it anytime at ', it: 'Hai perso il link? Lo ritrovi quando vuoi su ', fr: 'Lien perdu ? Retrouvez-le à tout moment sur ', es: '¿Perdiste el enlace? Recupéralo cuando quieras en ', de: 'Link verloren? Du findest ihn jederzeit unter ' },
  find_my_booking:  { en: 'Find my booking', it: 'Trova la mia prenotazione', fr: 'Retrouver ma réservation', es: 'Encontrar mi reserva', de: 'Meine Buchung finden' },
  your_receipts:    { en: 'Your receipts', it: 'Le tue ricevute', fr: 'Vos reçus', es: 'Tus recibos', de: 'Deine Belege' },
  reference_code:   { en: 'Reference code', it: 'Codice di riferimento', fr: 'Code de référence', es: 'Código de referencia', de: 'Referenzcode' },
  open_my_receipt:  { en: 'Open my receipt', it: 'Apri la mia ricevuta', fr: 'Ouvrir mon reçu', es: 'Abrir mi recibo', de: 'Meinen Beleg öffnen' },
  or_email_links:   { en: '…or email me my links', it: '…oppure inviami i link via email', fr: '…ou envoyez-moi mes liens par e-mail', es: '…o envíame mis enlaces por correo', de: '…oder schick mir meine Links per E-Mail' },
  email_me:         { en: 'Email me', it: 'Inviami l’email', fr: 'Envoyer', es: 'Enviarme', de: 'E-Mail senden' },
  your_account:     { en: 'Your account', it: 'Il tuo account', fr: 'Votre compte', es: 'Tu cuenta', de: 'Dein Konto' },
  sign_in:          { en: 'Sign in', it: 'Accedi', fr: 'Se connecter', es: 'Iniciar sesión', de: 'Anmelden' },
  signin_lead:      { en: "Enter your email — we'll send you a sign-in link. No password, ever.", it: 'Inserisci la tua email — ti inviamo un link di accesso. Nessuna password, mai.', fr: 'Saisissez votre e-mail — nous vous envoyons un lien de connexion. Jamais de mot de passe.', es: 'Escribe tu correo — te enviamos un enlace de acceso. Sin contraseña, nunca.', de: 'Gib deine E-Mail ein — wir senden dir einen Anmeldelink. Nie ein Passwort.' },
  email_signin:     { en: 'Email me a sign-in link', it: 'Inviami il link di accesso', fr: 'M’envoyer un lien de connexion', es: 'Enviarme el enlace de acceso', de: 'Anmeldelink senden' },
  signed_in_as:     { en: 'Signed in as ', it: 'Accesso effettuato come ', fr: 'Connecté en tant que ', es: 'Sesión iniciada como ', de: 'Angemeldet als ' },
  my_bookings:      { en: 'My bookings', it: 'Le mie prenotazioni', fr: 'Mes réservations', es: 'Mis reservas', de: 'Meine Buchungen' },
  records_empty:    { en: 'Nothing here yet — once you book, it shows up right here.', it: 'Ancora niente qui — appena prenoti, comparirà proprio qui.', fr: 'Rien pour l’instant — dès que vous réservez, cela apparaît ici.', es: 'Nada por aquí todavía — en cuanto reserves, aparecerá aquí.', de: 'Noch nichts hier — sobald du buchst, erscheint es genau hier.' },
  sign_out:         { en: 'Sign out', it: 'Esci', fr: 'Se déconnecter', es: 'Cerrar sesión', de: 'Abmelden' },
  sold_out_l:       { en: 'sold out', it: 'esaurito', fr: 'épuisé', es: 'agotado', de: 'ausverkauft' },
  how_to_pay:       { en: 'How to pay', it: 'Come pagare', fr: 'Comment payer', es: 'Cómo pagar', de: 'So wird bezahlt' },
  status_label:     { en: 'Status: ', it: 'Stato: ', fr: 'Statut : ', es: 'Estado: ', de: 'Status: ' },
  open:             { en: 'Open', it: 'Apri', fr: 'Ouvrir', es: 'Abrir', de: 'Öffnen' },
  choose:           { en: 'Choose…', it: 'Scegli…', fr: 'Choisir…', es: 'Elegir…', de: 'Wählen…' },
  receipt_dyn_eyebrow: { en: '{x} received', it: '{x} ricevuta', fr: '{x} reçue', es: '{x} recibida', de: '{x} erhalten' },
  // ---- THE CHAIN — the production record performs in the client's language ----
  chain_link:        { en: 'How this site was built', it: 'Come è stato costruito questo sito', fr: 'Comment ce site a été construit', es: 'Cómo se construyó este sitio', de: 'Wie diese Website gebaut wurde' },
  chain_eyebrow:     { en: 'Production record', it: 'Registro di produzione', fr: 'Registre de production', es: 'Registro de producción', de: 'Produktionsprotokoll' },
  chain_lead:        { en: 'From one written brief to the live product — by an automated production line. Every line below is read from the production database at this very moment; nothing here is written by hand.', it: 'Da un brief scritto al prodotto online — tramite una linea di produzione automatizzata. Ogni riga qui sotto è letta in questo preciso istante dal database di produzione; niente è scritto a mano.', fr: 'D’un brief écrit au produit en ligne — par une chaîne de production automatisée. Chaque ligne ci-dessous est lue à cet instant même dans la base de production ; rien n’est écrit à la main.', es: 'De un brief escrito al producto en línea — mediante una línea de producción automatizada. Cada línea de abajo se lee en este mismo instante de la base de datos de producción; nada está escrito a mano.', de: 'Vom geschriebenen Brief zum fertigen Produkt — durch eine automatisierte Produktionslinie. Jede Zeile unten wird in genau diesem Moment aus der Produktionsdatenbank gelesen; nichts hier ist von Hand geschrieben.' },
  chain_brief_h:     { en: 'The brief', it: 'Il brief', fr: 'Le brief', es: 'El brief', de: 'Der Brief' },
  chain_brief_lead:  { en: "The client's words, verbatim — this is all the agency was given.", it: 'Le parole del cliente, testuali — è tutto ciò che l’agenzia ha ricevuto.', fr: 'Les mots du client, mot pour mot — c’est tout ce que l’agence a reçu.', es: 'Las palabras del cliente, literales — es todo lo que recibió la agencia.', de: 'Die Worte des Kunden, wortwörtlich — mehr hat die Agentur nicht bekommen.' },
  chain_promise_h:   { en: 'The promise', it: 'La promessa', fr: 'La promesse', es: 'La promesa', de: 'Das Versprechen' },
  chain_promise_lead:{ en: 'Scoped before building: complexity {n}/5.', it: 'Definita prima di costruire: complessità {n}/5.', fr: 'Cadrée avant de construire : complexité {n}/5.', es: 'Definida antes de construir: complejidad {n}/5.', de: 'Vor dem Bau abgesteckt: Komplexität {n}/5.' },
  chain_excludes_h:  { en: 'Declared out of scope — with the honest alternative', it: 'Dichiarato fuori perimetro — con l’alternativa onesta', fr: 'Déclaré hors périmètre — avec l’alternative honnête', es: 'Declarado fuera de alcance — con la alternativa honesta', de: 'Ausdrücklich nicht enthalten — mit der ehrlichen Alternative' },
  chain_blueprint_h: { en: 'The blueprint', it: 'Il progetto', fr: 'Le plan', es: 'El plano', de: 'Der Bauplan' },
  chain_kind:        { en: 'Kind:', it: 'Tipo:', fr: 'Type :', es: 'Tipo:', de: 'Art:' },
  chain_design:      { en: 'Design language:', it: 'Linguaggio visivo:', fr: 'Langage visuel :', es: 'Lenguaje visual:', de: 'Designsprache:' },
  chain_opening:     { en: 'Opening treatment:', it: 'Apertura:', fr: 'Ouverture :', es: 'Apertura:', de: 'Auftakt:' },
  chain_opening_v:   { en: '{h} hero · {n} navigation', it: 'hero {h} · navigazione {n}', fr: 'héro {h} · navigation {n}', es: 'hero {h} · navegación {n}', de: 'Hero {h} · Navigation {n}' },
  chain_identity:    { en: 'Identity:', it: 'Identità:', fr: 'Identité :', es: 'Identidad:', de: 'Identität:' },
  chain_kind_site:   { en: 'a presentation site — every page verified', it: 'un sito di presentazione — ogni pagina verificata', fr: 'un site de présentation — chaque page vérifiée', es: 'un sitio de presentación — cada página verificada', de: 'eine Präsentationsseite — jede Seite geprüft' },
  chain_kind_app:    { en: 'a real application — its own database, forms compiled from the schema, receipts and accounts', it: 'una vera applicazione — un proprio database, moduli compilati dallo schema, ricevute e account', fr: 'une vraie application — sa propre base de données, des formulaires compilés depuis le schéma, des reçus et des comptes', es: 'una aplicación real — su propia base de datos, formularios compilados del esquema, recibos y cuentas', de: 'eine echte Anwendung — eigene Datenbank, aus dem Schema kompilierte Formulare, Belege und Konten' },
  chain_kind_store:  { en: 'a real store — live catalog, cart, server-priced checkout', it: 'un vero negozio — catalogo live, carrello, checkout con prezzi calcolati dal server', fr: 'une vraie boutique — catalogue en direct, panier, paiement au prix calculé côté serveur', es: 'una tienda real — catálogo en vivo, carrito, pago con precios calculados en el servidor', de: 'ein echter Shop — Live-Katalog, Warenkorb, serverseitig berechnete Kasse' },
  chain_kind_default:{ en: 'a presentation site', it: 'un sito di presentazione', fr: 'un site de présentation', es: 'un sitio de presentación', de: 'eine Präsentationsseite' },
  chain_db_h:        { en: 'The database', it: 'Il database', fr: 'La base de données', es: 'La base de datos', de: 'Die Datenbank' },
  chain_db_lead:     { en: 'Real tables, provisioned and verified for this product alone.', it: 'Tabelle reali, create e verificate solo per questo prodotto.', fr: 'De vraies tables, provisionnées et vérifiées pour ce seul produit.', es: 'Tablas reales, creadas y verificadas solo para este producto.', de: 'Echte Tabellen, allein für dieses Produkt angelegt und geprüft.' },
  chain_private_row: { en: 'Private visitor records — sealed from public view', it: 'Dati privati dei visitatori — sigillati alla vista pubblica', fr: 'Données privées des visiteurs — scellées au public', es: 'Registros privados de visitantes — sellados al público', de: 'Private Besucherdaten — für die Öffentlichkeit versiegelt' },
  chain_record_one:  { en: '{n} record, publicly presented', it: '{n} voce, presentata pubblicamente', fr: '{n} enregistrement, présenté publiquement', es: '{n} registro, presentado públicamente', de: '{n} Eintrag, öffentlich präsentiert' },
  chain_record_many: { en: '{n} records, publicly presented', it: '{n} voci, presentate pubblicamente', fr: '{n} enregistrements, présentés publiquement', es: '{n} registros, presentados públicamente', de: '{n} Einträge, öffentlich präsentiert' },
  chain_run_h:       { en: 'The production run', it: 'La produzione', fr: 'La production', es: 'La producción', de: 'Der Produktionslauf' },
  chain_stat_tasks:  { en: 'production tasks', it: 'attività di produzione', fr: 'tâches de production', es: 'tareas de producción', de: 'Produktionsschritte' },
  chain_stat_wall:   { en: 'wall time', it: 'tempo totale', fr: 'temps total', es: 'tiempo total', de: 'Gesamtzeit' },
  chain_stat_rebuilds:{ en: 'rebuild rounds', it: 'cicli di ricostruzione', fr: 'cycles de reconstruction', es: 'ciclos de reconstrucción', de: 'Neubau-Runden' },
  chain_none:        { en: 'none', it: 'nessuno', fr: 'aucun', es: 'ninguno', de: 'keine' },
  chain_repairs_one: { en: '{n} automatic repair was applied during planning — the system corrects its own drafts and says so.', it: '{n} riparazione automatica applicata in fase di pianificazione — il sistema corregge le proprie bozze e lo dichiara.', fr: '{n} réparation automatique appliquée pendant la planification — le système corrige ses propres brouillons et le dit.', es: '{n} reparación automática aplicada durante la planificación — el sistema corrige sus propios borradores y lo dice.', de: '{n} automatische Korrektur während der Planung — das System korrigiert seine eigenen Entwürfe und sagt es offen.' },
  chain_repairs_many:{ en: '{n} automatic repairs were applied during planning — the system corrects its own drafts and says so.', it: '{n} riparazioni automatiche applicate in fase di pianificazione — il sistema corregge le proprie bozze e lo dichiara.', fr: '{n} réparations automatiques appliquées pendant la planification — le système corrige ses propres brouillons et le dit.', es: '{n} reparaciones automáticas aplicadas durante la planificación — el sistema corrige sus propios borradores y lo dice.', de: '{n} automatische Korrekturen während der Planung — das System korrigiert seine eigenen Entwürfe und sagt es offen.' },
  chain_checks_h:    { en: 'The checks it passed', it: 'I controlli superati', fr: 'Les contrôles réussis', es: 'Los controles superados', de: 'Die bestandenen Prüfungen' },
  chain_checks_lead: { en: 'Deterministic gates — machine-verified, never an opinion.', it: 'Controlli deterministici — verificati dalla macchina, mai un’opinione.', fr: 'Des barrières déterministes — vérifiées par la machine, jamais une opinion.', es: 'Controles deterministas — verificados por la máquina, nunca una opinión.', de: 'Deterministische Prüfungen — maschinell verifiziert, nie eine Meinung.' },
  chain_review_pass: { en: '✓ Independent review: PASSED', it: '✓ Revisione indipendente: SUPERATA', fr: '✓ Revue indépendante : RÉUSSIE', es: '✓ Revisión independiente: SUPERADA', de: '✓ Unabhängige Prüfung: BESTANDEN' },
  chain_review_open: { en: 'Independent review: {n} finding(s) open', it: 'Revisione indipendente: {n} rilievi aperti', fr: 'Revue indépendante : {n} constat(s) ouvert(s)', es: 'Revisión independiente: {n} hallazgo(s) abiertos', de: 'Unabhängige Prüfung: {n} offene Befunde' },
  chain_browser:     { en: 'A real browser walked every page{p} and judged the result before this site was accepted.', it: 'Un browser reale ha percorso ogni pagina{p} e ha giudicato il risultato prima che questo sito fosse accettato.', fr: 'Un vrai navigateur a parcouru chaque page{p} et a jugé le résultat avant que ce site soit accepté.', es: 'Un navegador real recorrió cada página{p} y juzgó el resultado antes de aceptar este sitio.', de: 'Ein echter Browser besuchte jede Seite{p} und beurteilte das Ergebnis, bevor diese Website akzeptiert wurde.' },
  chain_browser_probe:{ en: ', performed the core action end to end,', it: ', ha eseguito l’azione principale dall’inizio alla fine,', fr: ', a effectué l’action principale de bout en bout,', es: ', realizó la acción principal de principio a fin,', de: ', führte die Kernaktion von Anfang bis Ende aus,' },
  chain_android_h:   { en: 'It is also an Android app', it: 'È anche un’app Android', fr: 'C’est aussi une appli Android', es: 'También es una app Android', de: 'Es ist auch eine Android-App' },
  chain_android_lead:{ en: "The same product, packaged and signed as a real Android application. Scan with a phone — Android verifies this site's own domain and opens it fullscreen, no browser bar.", it: 'Lo stesso prodotto, impacchettato e firmato come vera applicazione Android. Scansiona col telefono — Android verifica il dominio di questo sito e lo apre a schermo intero, senza barra del browser.', fr: 'Le même produit, empaqueté et signé comme une vraie application Android. Scannez avec un téléphone — Android vérifie le domaine de ce site et l’ouvre en plein écran, sans barre de navigateur.', es: 'El mismo producto, empaquetado y firmado como una aplicación Android real. Escanéalo con el móvil — Android verifica el dominio de este sitio y lo abre a pantalla completa, sin barra del navegador.', de: 'Dasselbe Produkt, verpackt und signiert als echte Android-App. Mit dem Handy scannen — Android verifiziert die Domain dieser Website und öffnet sie im Vollbild, ohne Browserleiste.' },
  chain_android_btn: { en: 'Download the app (.apk)', it: 'Scarica l’app (.apk)', fr: 'Télécharger l’appli (.apk)', es: 'Descargar la app (.apk)', de: 'App herunterladen (.apk)' },
  chain_check_privacy:{ en: 'privacy: visitor records are never publicly listable', it: 'privacy: i dati dei visitatori non sono mai elencabili pubblicamente', fr: 'confidentialité : les données des visiteurs ne sont jamais listables publiquement', es: 'privacidad: los registros de visitantes nunca son listables públicamente', de: 'Datenschutz: Besucherdaten sind nie öffentlich auflistbar' },
  chain_check_store: { en: 'a real browser BOUGHT from this store before it shipped (order + line items verified in the database)', it: 'un browser reale ha COMPRATO in questo negozio prima della consegna (ordine e righe verificati nel database)', fr: 'un vrai navigateur a ACHETÉ dans cette boutique avant la livraison (commande et lignes vérifiées en base)', es: 'un navegador real COMPRÓ en esta tienda antes de entregarla (pedido y líneas verificados en la base de datos)', de: 'ein echter Browser hat in diesem Shop GEKAUFT, bevor er ausgeliefert wurde (Bestellung + Positionen in der Datenbank verifiziert)' },
  chain_check_app:   { en: 'a real browser performed the core action and followed its receipt before this site shipped', it: 'un browser reale ha eseguito l’azione principale e seguito la sua ricevuta prima della consegna', fr: 'un vrai navigateur a effectué l’action principale et suivi son reçu avant la livraison', es: 'un navegador real realizó la acción principal y siguió su recibo antes de la entrega', de: 'ein echter Browser führte die Kernaktion aus und folgte seinem Beleg vor der Auslieferung' },
  chain_v_render:    { en: 'every page renders correctly, desktop and mobile', it: 'ogni pagina si visualizza correttamente, desktop e mobile', fr: 'chaque page s’affiche correctement, ordinateur et mobile', es: 'cada página se muestra correctamente, escritorio y móvil', de: 'jede Seite rendert korrekt, Desktop und Mobil' },
  chain_v_sql:       { en: 'the database schema applies cleanly to a real PostgreSQL', it: 'lo schema del database si applica senza errori a un vero PostgreSQL', fr: 'le schéma de base s’applique proprement à un vrai PostgreSQL', es: 'el esquema de la base se aplica limpiamente a un PostgreSQL real', de: 'das Datenbankschema läuft sauber auf einem echten PostgreSQL' },
  chain_v_consistent:{ en: 'one brand, one navigation — identical on every page', it: 'un solo brand, una sola navigazione — identici su ogni pagina', fr: 'une seule marque, une seule navigation — identiques sur chaque page', es: 'una sola marca, una sola navegación — idénticas en cada página', de: 'eine Marke, eine Navigation — identisch auf jeder Seite' },
  chain_v_cms:       { en: 'pages are served from the CMS, not from stale copies', it: 'le pagine sono servite dal CMS, non da copie obsolete', fr: 'les pages sont servies depuis le CMS, pas depuis des copies périmées', es: 'las páginas se sirven desde el CMS, no desde copias obsoletas', de: 'Seiten kommen aus dem CMS, nicht aus veralteten Kopien' },
  chain_v_json:      { en: 'every structured hand-off parsed and validated', it: 'ogni passaggio strutturato analizzato e validato', fr: 'chaque passage structuré analysé et validé', es: 'cada traspaso estructurado analizado y validado', de: 'jede strukturierte Übergabe geparst und validiert' },
  receipt_dyn_title:   { en: 'Your {x} is in', it: 'La tua {x} è registrata', fr: 'Votre {x} est enregistrée', es: 'Tu {x} está registrada', de: 'Deine {x} ist eingegangen' },
  // visitor-facing ACTION errors (appdb) — the English values are byte-exact with the historical
  // strings so every existing gate that asserts them stays green
  err_name_required: { en: 'your name is required', it: 'il nome è obbligatorio', fr: 'votre nom est requis', es: 'tu nombre es obligatorio', de: 'dein Name ist erforderlich' },
  err_email_required: { en: 'a real email is required', it: 'serve un indirizzo email valido', fr: 'une adresse e-mail valide est requise', es: 'se necesita un correo válido', de: 'eine gültige E-Mail ist erforderlich' },
  err_product_gone: { en: 'a product in your cart no longer exists', it: 'un prodotto nel tuo carrello non esiste più', fr: 'un article de votre panier n’existe plus', es: 'un producto de tu carrito ya no existe', de: 'ein Produkt in deinem Warenkorb existiert nicht mehr' },
  err_option_gone: { en: 'that option no longer exists — refresh and pick again', it: 'quell’opzione non esiste più — aggiorna e scegli di nuovo', fr: 'cette option n’existe plus — actualisez et choisissez à nouveau', es: 'esa opción ya no existe — actualiza y elige otra vez', de: 'diese Option existiert nicht mehr — bitte neu laden und erneut wählen' },
  err_sold_out_item: { en: '"{t}" is sold out', it: '"{t}" è esaurito', fr: '« {t} » est épuisé', es: '"{t}" está agotado', de: '„{t}“ ist ausverkauft' },
  err_only_n_of: { en: 'only {n} of "{t}" left — reduce the quantity', it: 'restano solo {n} di "{t}" — riduci la quantità', fr: 'plus que {n} de « {t} » — réduisez la quantité', es: 'solo quedan {n} de "{t}" — reduce la cantidad', de: 'nur noch {n} von „{t}“ — bitte Menge verringern' },
  err_has_options: { en: '"{t}" comes in options — choose one on its product page, then add it to the cart', it: '"{t}" ha delle opzioni — scegline una nella sua pagina, poi aggiungila al carrello', fr: '« {t} » existe en plusieurs options — choisissez-en une sur sa page produit', es: '"{t}" tiene opciones — elige una en su página y añádela al carrito', de: '„{t}“ gibt es in Varianten — wähle eine auf der Produktseite und lege sie in den Warenkorb' },
  err_past_date: { en: 'that {f} is in the past — pick an upcoming date', it: 'quella {f} è nel passato — scegli una data futura', fr: 'cette {f} est passée — choisissez une date à venir', es: 'esa {f} ya pasó — elige una fecha próxima', de: 'dieses {f} liegt in der Vergangenheit — bitte ein kommendes Datum wählen' },
  err_slot_taken: { en: 'that slot was just taken — pick another time', it: 'quell’orario è appena stato preso — scegline un altro', fr: 'ce créneau vient d’être pris — choisissez un autre horaire', es: 'esa hora se acaba de ocupar — elige otra', de: 'dieser Termin wurde gerade vergeben — bitte eine andere Zeit wählen' },
  err_slot_full: { en: 'that time is fully booked — pick another slot', it: 'quell’orario è al completo — scegli un altro orario', fr: 'cet horaire est complet — choisissez un autre créneau', es: 'esa hora está completa — elige otro horario', de: 'diese Zeit ist ausgebucht — bitte einen anderen Termin wählen' },
  err_not_image: { en: 'not a valid image', it: 'immagine non valida', fr: 'image non valide', es: 'imagen no válida', de: 'kein gültiges Bild' },
  err_image_big: { en: 'image too large (max 3 MB)', it: 'immagine troppo grande (max 3 MB)', fr: 'image trop lourde (max 3 Mo)', es: 'imagen demasiado grande (máx. 3 MB)', de: 'Bild zu groß (max. 3 MB)' },
  err_bad_filetype: { en: 'unsupported file type — use JPG, PNG, WebP or GIF', it: 'formato non supportato — usa JPG, PNG, WebP o GIF', fr: 'format non pris en charge — utilisez JPG, PNG, WebP ou GIF', es: 'formato no compatible — usa JPG, PNG, WebP o GIF', de: 'Dateityp nicht unterstützt — nutze JPG, PNG, WebP oder GIF' },
};

// the lookup: unknown locale falls to 'en'; {n}-style slots are filled from args.
// An unknown KEY throws — a typo'd key must die in the suite, not ship as 'undefined'.
export function L(locale: string | undefined, key: string, args?: Record<string, string | number>): string {
  const row = STRINGS[key];
  if (!row) throw new Error('i18n: unknown key ' + key);
  let s = row[isLocale(locale) ? locale : 'en'];
  if (args) for (const [k, v] of Object.entries(args)) s = s.split('{' + k + '}').join(String(v));
  return s;
}

// the client-runtime dictionary — ONLY the keys the emitted browser JS needs, injected as JSON
// (never string-spliced into code: JSON.stringify is the escaping)
const CLIENT_KEYS = ['added_ok', 'thanks_msg', 'error_retry', 'generic_error', 'no_receipt_code', 'check_inbox', 'links_on_way',
  'search_ph', 'search_aria', 'from_price', 'choose_options', 'only_n_left', 'add_to_cart', 'no_times', 'pick_option',
  'cart_empty', 'remove', 'total', 'proceed_checkout', 'cart_empty_add', 'order_placed', 'total_sep', 'sold_out'] as const;
export function clientDict(locale: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of CLIENT_KEYS) out[k] = L(locale, k);
  out.cur = curSym(locale);
  out.meur = currencyFor(locale) === 'EUR' ? '1' : '';   // client __money switches format on this
  return out;
}

// ---- currency: a build property derived from the locale (v1: symbol only, math untouched) ----
export function currencyFor(locale: string | undefined): 'USD' | 'EUR' { return isLocale(locale) && locale !== 'en' ? 'EUR' : 'USD'; }
export function curSym(locale: string | undefined): string { return currencyFor(locale) === 'EUR' ? '€' : '$'; }
// the ONE money formatter: en → $12.00 (byte-identical with history); EUR locales → 12,00 €
export function fmtMoney(locale: string | undefined, n: number): string {
  const v = (Math.round(Number(n) * 100) / 100).toFixed(2);
  return currencyFor(locale) === 'EUR' ? v.replace('.', ',') + ' €' : '$' + v;
}

// ---- common schema column names → localized form labels. ENGLISH ALWAYS USES THE FALLBACK
// (humanize), so existing sites stay byte-identical; non-en locales translate what they know
// and humanize the rest (an unknown column is better half-translated than wrong).
const COLUMN_LABELS: Record<string, Record<Exclude<Locale, 'en'>, string>> = {
  customer_name: { it: 'Nome e cognome', fr: 'Nom complet', es: 'Nombre completo', de: 'Vollständiger Name' },
  name: { it: 'Nome', fr: 'Nom', es: 'Nombre', de: 'Name' },
  email: { it: 'Email', fr: 'E-mail', es: 'Correo electrónico', de: 'E-Mail' },
  phone: { it: 'Telefono', fr: 'Téléphone', es: 'Teléfono', de: 'Telefon' },
  date: { it: 'Data', fr: 'Date', es: 'Fecha', de: 'Datum' },
  time: { it: 'Orario', fr: 'Heure', es: 'Hora', de: 'Uhrzeit' },
  notes: { it: 'Note', fr: 'Remarques', es: 'Notas', de: 'Anmerkungen' },
  message: { it: 'Messaggio', fr: 'Message', es: 'Mensaje', de: 'Nachricht' },
  party_size: { it: 'Numero di persone', fr: 'Nombre de personnes', es: 'Número de personas', de: 'Personenzahl' },
  guests: { it: 'Ospiti', fr: 'Invités', es: 'Invitados', de: 'Gäste' },
  number_of_guests: { it: 'Numero di ospiti', fr: 'Nombre d’invités', es: 'Número de invitados', de: 'Anzahl der Gäste' },
  service: { it: 'Servizio', fr: 'Service', es: 'Servicio', de: 'Leistung' },
  quantity: { it: 'Quantità', fr: 'Quantité', es: 'Cantidad', de: 'Menge' },
  address: { it: 'Indirizzo', fr: 'Adresse', es: 'Dirección', de: 'Adresse' },
  subject: { it: 'Oggetto', fr: 'Objet', es: 'Asunto', de: 'Betreff' },
  city: { it: 'Città', fr: 'Ville', es: 'Ciudad', de: 'Stadt' },
  company: { it: 'Azienda', fr: 'Entreprise', es: 'Empresa', de: 'Firma' },
  booking_date: { it: 'Data della prenotazione', fr: 'Date de réservation', es: 'Fecha de la reserva', de: 'Buchungsdatum' },
  reservation_date: { it: 'Data della prenotazione', fr: 'Date de réservation', es: 'Fecha de la reserva', de: 'Reservierungsdatum' },
  appointment_date: { it: 'Data dell’appuntamento', fr: 'Date du rendez-vous', es: 'Fecha de la cita', de: 'Termindatum' },
  preferred_date: { it: 'Data preferita', fr: 'Date souhaitée', es: 'Fecha preferida', de: 'Wunschdatum' },
  preferred_time: { it: 'Orario preferito', fr: 'Heure souhaitée', es: 'Hora preferida', de: 'Wunschzeit' },
};
export function columnLabel(locale: string | undefined, column: string, fallback: string): string {
  if (!isLocale(locale) || locale === 'en') return fallback;
  const row = COLUMN_LABELS[String(column || '').toLowerCase()];
  return row?.[locale] ?? fallback;
}
