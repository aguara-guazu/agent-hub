"""Read only the selected X11 window's backing pixmap, including when another window covers it."""
import ctypes as c
import json
import struct
import sys
import zlib


def function(lib, name, result, *args):
    fn = getattr(lib, name)
    fn.restype, fn.argtypes = result, args
    return fn


class XImage(c.Structure):
    _fields_ = [
        ("width", c.c_int), ("height", c.c_int), ("xoffset", c.c_int), ("format", c.c_int),
        ("data", c.c_void_p), ("byte_order", c.c_int), ("bitmap_unit", c.c_int),
        ("bitmap_bit_order", c.c_int), ("bitmap_pad", c.c_int), ("depth", c.c_int),
        ("stride", c.c_int), ("bpp", c.c_int), ("red", c.c_ulong), ("green", c.c_ulong), ("blue", c.c_ulong),
    ]


def capture(window):
    x11 = c.CDLL("libX11.so.6")
    comp = c.CDLL("libXcomposite.so.1")
    display = function(x11, "XOpenDisplay", c.c_void_p, c.c_char_p)(None)
    if not display:
        raise RuntimeError("X11 unavailable")
    prefix = (c.c_void_p, c.c_ulong)
    function(comp, "XCompositeRedirectWindow", None, *prefix, c.c_int)(display, window, 0)
    pixmap = function(comp, "XCompositeNameWindowPixmap", c.c_ulong, *prefix)(display, window)
    root, x, y = c.c_ulong(), c.c_int(), c.c_int()
    width, height, border, depth = (c.c_uint() for _ in range(4))
    geom = (root, x, y, width, height, border, depth)
    get_geometry = function(x11, "XGetGeometry", c.c_int, *prefix, *(c.POINTER(type(v)) for v in geom))
    if not get_geometry(display, pixmap, *(c.byref(v) for v in geom)):
        raise RuntimeError("Window unavailable")
    w, h = width.value, height.value
    if not (0 < w <= 8192 and 0 < h <= 8192 and w * h <= 18000000):
        raise RuntimeError("Unsupported window dimensions")
    get_image = function(x11, "XGetImage", c.POINTER(XImage), *prefix, c.c_int, c.c_int, c.c_uint, c.c_uint, c.c_ulong, c.c_int)
    img = get_image(display, pixmap, 0, 0, w, h, c.c_ulong(-1), 2).contents
    # XGetImage on a pixmap has no visual and may report zero masks. Standard 24/32-bit TrueColor is BGRX.
    if img.byte_order != 0 or img.bpp != 32 or img.depth not in (24, 32) or img.stride < 4*w:
        raise RuntimeError("Unsupported pixel layout")
    step = max(1, (max(w, h) + 1919) // 1920)
    out_w, out_h = (w + step - 1) // step, (h + step - 1) // step
    rows = bytearray()
    for row in range(0, h, step):
        src = c.string_at(img.data + row * img.stride, w * 4)
        rgb = bytearray(out_w * 3)
        for dest, channel in enumerate((2, 1, 0)):
            rgb[dest::3] = src[channel::4*step]
        rows.append(0)
        rows.extend(rgb)

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    header = struct.pack(">IIBBBBB", out_w, out_h, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows, 1)) + chunk(b"IEND", b"")


def titles(windows):
    """Modern X11 apps can keep the application name in WM_NAME and the actual page title in _NET_WM_NAME."""
    x11 = c.CDLL("libX11.so.6")
    d = function(x11, "XOpenDisplay", c.c_void_p, c.c_char_p)(None)
    if not d:
        return {}
    atom = function(x11, "XInternAtom", c.c_ulong, c.c_void_p, c.c_char_p, c.c_int)
    title, utf8 = atom(d, b"_NET_WM_NAME", 1), atom(d, b"UTF8_STRING", 1)
    result = {}
    if title and utf8:
        # Windows can disappear between enumeration and this query.
        callback = c.CFUNCTYPE(c.c_int, c.c_void_p, c.c_void_p)
        ignore = callback(lambda *_: 0)
        function(x11, "XSetErrorHandler", c.c_void_p, callback)(ignore)
        get = function(x11, "XGetWindowProperty", c.c_int, c.c_void_p, c.c_ulong, c.c_ulong, c.c_long, c.c_long,
                       c.c_int, c.c_ulong, c.POINTER(c.c_ulong), c.POINTER(c.c_int), c.POINTER(c.c_ulong),
                       c.POINTER(c.c_ulong), c.POINTER(c.c_void_p))
        free = function(x11, "XFree", c.c_int, c.c_void_p)
        for window in windows:
            kind, bits, size, rest, data = c.c_ulong(), c.c_int(), c.c_ulong(), c.c_ulong(), c.c_void_p()
            status = get(d, int(window), title, 0, 512, 0, utf8, c.byref(kind), c.byref(bits), c.byref(size), c.byref(rest), c.byref(data))
            if data:
                if status == 0 and kind.value == utf8 and bits.value == 8 and size.value:
                    result[window] = c.string_at(data, size.value).decode("utf-8", "replace").split("\x00")[0]
                free(data)
    function(x11, "XCloseDisplay", c.c_int, c.c_void_p)(d)
    return result


if __name__ == "__main__":
    if sys.argv[1] == "--titles":
        print(json.dumps(titles(sys.argv[2:]), ensure_ascii=False))
    else:
        sys.stdout.buffer.write(capture(int(sys.argv[1])))
