package dev.boujoy.personalagent;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.math.BigInteger;
import java.net.Socket;
import java.security.*;
import java.security.cert.*;
import java.security.spec.ECGenParameterSpec;
import java.util.*;
import javax.net.ssl.*;
import javax.security.auth.x500.X500Principal;

/** Standard TLS 1.3 with Android Keystore client identity and an explicitly bound server SPKI. */
public final class DeviceIdentity {
    static final String LEGACY_ALIAS="boujoy.remote-device",TLS_ALIAS="boujoy.remote-device.tls-v2";
    private final KeyStore keys;
    private final String alias;
    public DeviceIdentity()throws Exception{this(LEGACY_ALIAS,false);}
    public DeviceIdentity(String alias)throws Exception{this(alias,false);}
    private DeviceIdentity(String alias,boolean create)throws Exception{
        if(!Set.of(LEGACY_ALIAS,TLS_ALIAS).contains(alias))throw new IllegalArgumentException("手机身份名称无效");
        this.alias=alias;keys=KeyStore.getInstance("AndroidKeyStore");keys.load(null);
        if(!keys.containsAlias(alias)){
            if(!create)throw new KeyStoreException("手机身份不可用，请重新绑定，原身份不会被自动替换");
            KeyPairGenerator generator=KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC,"AndroidKeyStore");
            // Android TLS hashes the handshake itself and calls NONEwithECDSA.
            generator.initialize(new KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_SIGN|KeyProperties.PURPOSE_VERIFY)
                    .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                    .setDigests(KeyProperties.DIGEST_NONE,KeyProperties.DIGEST_SHA256,KeyProperties.DIGEST_SHA384)
                    .setCertificateSubject(new X500Principal("CN=Boujoy Android"))
                    .setCertificateSerialNumber(new BigInteger(120,new SecureRandom()).add(BigInteger.ONE))
                    .setCertificateNotBefore(new Date(System.currentTimeMillis()-86400000))
                    .setCertificateNotAfter(new Date(System.currentTimeMillis()+10L*365*86400000)).build());
            generator.generateKeyPair();
        }
    }
    /** Called only after an explicit, validated import. Never deletes or overwrites an identity. */
    static String preparePairing()throws Exception{
        KeyStore existing=KeyStore.getInstance("AndroidKeyStore");existing.load(null);
        if(existing.containsAlias(LEGACY_ALIAS)){
            try{new DeviceIdentity(LEGACY_ALIAS).verifySigning();return LEGACY_ALIAS;}
            catch(InvalidKeyException incompatible){/* retain legacy key; new pairing can use the TLS identity */}
        }
        DeviceIdentity next=new DeviceIdentity(TLS_ALIAS,true);next.verifySigning();return TLS_ALIAS;
    }
    private void verifySigning()throws Exception{
        PrivateKey key=(PrivateKey)keys.getKey(alias,null);byte[] challenge=new byte[32];new SecureRandom().nextBytes(challenge);
        Signature signer=Signature.getInstance("NONEwithECDSA");signer.initSign(key);signer.update(challenge);byte[] signed=signer.sign();
        Signature verifier=Signature.getInstance("NONEwithECDSA");verifier.initVerify(keys.getCertificate(alias));verifier.update(challenge);
        if(!verifier.verify(signed))throw new InvalidKeyException("手机身份签名校验失败");
    }
    public SSLContext context(String boundPin)throws Exception{
        verifySigning();
        X509Certificate certificate=(X509Certificate)keys.getCertificate(alias);
        PrivateKey privateKey=(PrivateKey)keys.getKey(alias,null);
        X509ExtendedKeyManager manager=new X509ExtendedKeyManager(){
            public String[] getClientAliases(String type,Principal[] issuers){return "EC".equals(type)?new String[]{alias}:null;}
            public String chooseClientAlias(String[] types,Principal[] issuers,Socket socket){return Arrays.asList(types).contains("EC")?alias:null;}
            public String chooseEngineClientAlias(String[] types,Principal[] issuers,SSLEngine engine){return Arrays.asList(types).contains("EC")?alias:null;}
            public String[] getServerAliases(String type,Principal[] issuers){return null;}
            public String chooseServerAlias(String type,Principal[] issuers,Socket socket){return null;}
            public X509Certificate[] getCertificateChain(String alias){return DeviceIdentity.this.alias.equals(alias)?new X509Certificate[]{certificate}:null;}
            public PrivateKey getPrivateKey(String alias){return DeviceIdentity.this.alias.equals(alias)?privateKey:null;}
        };
        SSLContext context=SSLContext.getInstance("TLSv1.3");context.init(new KeyManager[]{manager},new TrustManager[]{pinnedTrust(boundPin)},new SecureRandom());return context;
    }
    // The inner gateway is self-signed: validate its lifetime and the bound
    // SHA-256 SPKI pin below. The outer WSS still uses platform CA validation.
    @android.annotation.SuppressLint("CustomX509TrustManager")
    static X509TrustManager pinnedTrust(String boundPin){
        return new X509TrustManager(){
            public X509Certificate[] getAcceptedIssuers(){return new X509Certificate[0];}
            public void checkClientTrusted(X509Certificate[] chain,String type)throws CertificateException{throw new CertificateException("Not a server");}
            public void checkServerTrusted(X509Certificate[] chain,String type)throws CertificateException{
                if(chain==null||chain.length==0)throw new CertificateException("Missing gateway identity");
                try {
                    chain[0].checkValidity();byte[] actual=MessageDigest.getInstance("SHA-256").digest(chain[0].getPublicKey().getEncoded());
                    String pin=boundPin.replaceFirst("^sha256/","");byte[] expected;
                    if(pin.matches("[A-Fa-f0-9]{64}")){expected=new byte[32];for(int i=0;i<32;i++)expected[i]=(byte)Integer.parseInt(pin.substring(i*2,i*2+2),16);}
                    else expected=Base64.getDecoder().decode(pin);
                    if(!MessageDigest.isEqual(actual,expected))throw new CertificateException("电脑身份已变化，已停止连接");
                }catch(CertificateException e){throw e;}catch(Exception e){throw new CertificateException("Invalid gateway binding",e);}
            }
        };
    }
}
