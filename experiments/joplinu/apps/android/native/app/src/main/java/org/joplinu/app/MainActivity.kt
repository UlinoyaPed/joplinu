package org.joplinu.app
import android.os.Bundle
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(JoplinuStoragePlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
