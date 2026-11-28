-- Banner photos take turns at the top of a client's home page (asked for by Eric, Nov 27, 2026), so a client may now have
-- several banners, shown in position order. src/photos.js caps them at 15 (and 30 photos in all).
DROP INDEX client_photos_one_banner;
