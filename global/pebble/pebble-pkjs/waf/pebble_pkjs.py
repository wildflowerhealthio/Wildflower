"""
Waf helpers for a Pebble watchapp whose PebbleKit JS is TypeScript, bundled by
`vp pack` (see pebble-pkjs's README). An app's wscript puts this directory on
`sys.path`, imports this module and calls `bundle_pkjs` at the top of `build`.
"""
import shutil


def find_vp(ctx):
    """
    The workspace's own `vp` (node_modules/.bin, which `vp install` fills), found
    from the app's directory upwards, else the one on PATH.
    """
    node = ctx.path
    while node is not None:
        workspace_vp = node.find_node('node_modules/.bin/vp')
        if workspace_vp is not None:
            return workspace_vp.abspath()
        node = node.parent
    return shutil.which('vp')


def bundle_pkjs(ctx, pkjs_dir='pkjs'):
    """
    The PebbleKit JS is TypeScript in `pkjs_dir`, whose `vp pack` bundles it to
    ES5 as src/pkjs/index.js, which the wscript's bundle step reads. Build it
    first so a plain `pebble build` never packs a stale or missing bundle.
    """
    vp = find_vp(ctx)
    if vp is None:
        ctx.fatal('Bundling the PebbleKit JS needs Vite+ (`vp`): run `vp install` at the '
                  'repository root, or put `vp` on the PATH')
    if ctx.exec_command([vp, 'pack'], cwd=ctx.path.find_dir(pkjs_dir).abspath()) != 0:
        ctx.fatal('Bundling the PebbleKit JS (`vp pack` in {}/) failed'.format(pkjs_dir))
